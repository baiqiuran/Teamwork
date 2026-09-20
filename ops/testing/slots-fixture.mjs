import { writeFile, mkdir, symlink } from "node:fs/promises";
import { fixture, run, port } from "./fixture.mjs";

export async function slotsFixture(t) {
  const f = await fixture();
  const bluePort = Number(new URL(f.config.probeUrl).port),
    greenPort = await port();
  const greenUnit = `${f.id}-green.service`;
  t.after(() => {
    run("systemctl", "stop", f.config.unit, greenUnit);
  });
  for (const slot of ["blue", "green"])
    await mkdir(`${f.root}/slots/${slot}`, { recursive: true });
  await symlink(`${f.root}/releases/initial`, `${f.root}/slots/blue/current`);
  await writeFile(
    `${f.root}/health-token`,
    "isolated_health_token_012345678901234567890",
  );
  await writeFile(`${f.root}/upstream`, `server 127.0.0.1:${bluePort};\n`);
  const proxyPort = new URL(f.origin).port;
  await writeFile(
    `/etc/nginx/conf.d/${f.id}.conf`,
    `upstream upstream_${f.id.replaceAll("-", "_")} { include ${f.root}/upstream; }
server { listen 127.0.0.1:${proxyPort}; error_page 503 = @maintenance;
location @maintenance { default_type application/json; add_header Retry-After 60 always; return 503 '{"error":"服务维护中，请稍后重试。"}'; }
location /internal/ { return 404; }
location / { if (-f ${f.root}/maintenance) { return 503; } proxy_pass http://upstream_${f.id.replaceAll("-", "_")}; proxy_set_header Host $http_host; proxy_set_header X-Daily-Health ""; } }`,
  );
  await writeFile(
    `/etc/systemd/system/${greenUnit}`,
    `[Service]\nUser=nobody\nWorkingDirectory=${f.root}/slots/green/current\nEnvironmentFile=${f.root}/config.env\nEnvironmentFile=${f.root}/green.env\nExecStart=/usr/bin/flock --nonblock ${f.root}/data.lock /usr/local/bin/node build/server/main.js\nTimeoutStopSec=35\nKillMode=control-group\n`,
  );
  run("systemctl", "daemon-reload");
  run("nginx", "-t");
  run("systemctl", "reload", "nginx");
  f.config.slots = {
    blue: {
      unit: f.config.unit,
      port: bluePort,
      link: `${f.root}/slots/blue/current`,
      envFile: `${f.root}/blue.env`,
    },
    green: {
      unit: greenUnit,
      port: greenPort,
      link: `${f.root}/slots/green/current`,
      envFile: `${f.root}/green.env`,
    },
  };
  f.config.activeSlot = "blue";
  f.config.upstreamFile = `${f.root}/upstream`;
  f.config.healthTokenFile = `${f.root}/health-token`;
  await writeFile(`${f.root}/deploy.json`, JSON.stringify(f.config));
  return f;
}
