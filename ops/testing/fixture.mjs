import assert from "node:assert/strict";
import { read as fetch } from "../http.mjs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  writeFile,
  readFile,
  symlink,
  cp,
  readdir,
  access,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";

export const run = (command, ...args) =>
  execFileSync(command, args, { encoding: "utf8" });
export async function port() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const result = server.address().port;
  await new Promise((done) => server.close(done));
  return result;
}
export async function fixture() {
  assert.equal(
    process.platform,
    "linux",
    "Requires an isolated Linux systemd host",
  );
  const id = `daily-test-${randomUUID()}`,
    root = `/srv/${id}`;
  const appPort = await port(),
    proxyPort = await port();
  await mkdir(root, { recursive: true });
  await mkdir(`${root}/data`);
  await writeFile(`${root}/data.lock`, "");
  run("chown", "-R", "nobody", `${root}/data`, `${root}/data.lock`);
  await mkdir(`${root}/control`);
  await mkdir(`${root}/backups`);
  await mkdir(`${root}/releases`);
  await cp("/fixture-runtime", `${root}/releases/initial`, { recursive: true });
  await symlink(`${root}/releases/initial`, `${root}/current`);
  await writeFile(
    `${root}/config.env`,
    `PORT=${appPort}\nDAILY_DATABASE_PATH=${root}/data/daily.sqlite\nDAILY_SETUP_KEY=backup-test-key\n`,
    { mode: 0o600 },
  );
  await writeFile(
    `/etc/systemd/system/${id}.service`,
    `[Unit]\nDescription=Isolated backup fixture\n[Service]\nUser=nobody\nWorkingDirectory=${root}/current\nEnvironmentFile=${root}/config.env\nExecStart=/usr/bin/flock --nonblock ${root}/data.lock /usr/local/bin/node build/server/main.js\nExecStop=/bin/sleep 1\nTimeoutStopSec=30\nKillMode=control-group\n`,
  );
  await writeFile(
    `/etc/nginx/conf.d/${id}.conf`,
    `server { listen 127.0.0.1:${proxyPort}; error_page 503 = @maintenance; location @maintenance { default_type application/json; add_header Retry-After 60 always; return 503 '{"error":"maintenance","message":"服务维护中，请稍后重试。"}'; } location / { if (-f ${root}/maintenance) { return 503; } proxy_pass http://127.0.0.1:${appPort}; proxy_set_header Host $http_host; } }`,
  );
  run("systemctl", "daemon-reload");
  run("nginx", "-t");
  run("systemctl", "reload", "nginx");
  run("systemctl", "start", `${id}.service`);
  const config = {
    schema: 1,
    dataDir: `${root}/data`,
    database: "daily.sqlite",
    stateDir: `${root}/control`,
    backupDir: `${root}/backups`,
    current: `${root}/current`,
    releases: `${root}/releases`,
    envFile: `${root}/config.env`,
    artifact: "/fixture-artifact/application.tar.gz",
    unit: `${id}.service`,
    maintenance: `${root}/maintenance`,
    dataLock: `${root}/data.lock`,
    probeUrl: `http://127.0.0.1:${appPort}/api/setup/status`,
    serviceUser: "nobody",
    ingressUrl: `http://127.0.0.1:${proxyPort}`,
    reserveBytes: 1048576,
  };
  await writeFile(`${root}/deploy.json`, JSON.stringify(config));
  const origin = `http://127.0.0.1:${proxyPort}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await fetch(`${origin}/api/setup/status`)).status === 200) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  let cookie = "";
  const request = async (path, body, raw = false) => {
    const response = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: config.recoveryPublicUrl ?? origin,
        Host: new URL(config.recoveryPublicUrl ?? origin).host,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const next = response.headers.get("set-cookie");
    if (next) cookie = next.split(";")[0];
    assert.ok(response.ok, `${path}: ${response.status}`);
    return raw ? response.text() : response.json();
  };
  await request("/api/setup", {
    setupKey: "backup-test-key",
    teamName: "备份团队",
    name: "备份成员",
    email: "backup@example.test",
    password: "BackupFixture2026!",
  });
  const entryId = randomUUID();
  let diary = await request("/api/diaries", {
    title: "必须保留的日报",
    entries: [{ id: entryId, body: "恢复前的内容" }],
  });
  diary = await request(
    `/api/diaries/${diary.id}/entries/${entryId}/attachments`,
    {
      version: diary.version,
      requestId: randomUUID(),
      name: "backup.txt",
      base64: Buffer.from("original attachment bytes").toString("base64"),
    },
  );
  diary = await request(`/api/diaries/${diary.id}/submit`, {
    version: diary.version,
    requestId: randomUUID(),
  });
  const attachment = diary.published.entries[0].attachments[0].id;
  const controlWith = (nodeArgs, ...args) => {
    const child = spawn(
      process.execPath,
      [
        ...nodeArgs,
        resolve("ops/control.mjs"),
        "--config",
        `${root}/deploy.json`,
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      error = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (error += chunk));
    return once(child, "exit").then(([code]) => ({ code, output, error }));
  };
  const control = (...args) => controlWith([], ...args);
  return {
    root,
    id,
    origin,
    config,
    request,
    control,
    controlWith,
    diary,
    attachment,
  };
}
