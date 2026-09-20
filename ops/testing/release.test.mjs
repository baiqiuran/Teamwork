import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, readFile, mkdir, symlink } from "node:fs/promises";
import { fixture, run, port } from "./fixture.mjs";
import { randomBytes, randomUUID, createHash } from "node:crypto";

async function slotsFixture(t) {
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

test("verified release switches real slots with one writer and preserved member data", async (t) => {
  const f = await slotsFixture(t);
  const baseline = JSON.parse(
    await readFile(`${f.root}/current/release.json`, "utf8"),
  ).commit;
  const target = JSON.parse(
    await readFile("/candidate-artifact/receipt.json", "utf8"),
  ).commit;
  const rejected = await f.control(
    "release",
    "--id",
    "stale",
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    "0".repeat(40),
  );
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.output, /BASELINE_CHANGED/);
  assert.equal((await fetch(f.origin + "/login")).status, 200);
  const verifier = randomBytes(32).toString("base64url");
  const scopes = ["progress:read", "drafts:write"];
  const authRequest = {
    client_id: "daily-flow-codex",
    redirect_uri: "http://127.0.0.1:19876/callback",
    resource: f.origin + "/mcp",
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    scope: scopes.join(" "),
    state: "isolated-state",
  };
  const approval = await f.request("/api/ai/authorize", {
    request: authRequest,
    scopes,
    approve: true,
  });
  const token = await fetch(f.origin + "/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: authRequest.client_id,
      redirect_uri: authRequest.redirect_uri,
      resource: authRequest.resource,
      code: new URL(approval.redirect).searchParams.get("code"),
      code_verifier: verifier,
    }),
  }).then((r) => r.json());
  const draft = {
    operationId: randomUUID(),
    title: "切换时重试",
    entries: [{ id: randomUUID(), body: "MCP 保留回执" }],
  };
  const call = async () => {
    const r = await fetch(f.origin + "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_draft", arguments: draft },
      }),
    });
    assert.equal(r.status, 200);
    const result = await r.json();
    assert.ok(!result.result.isError, JSON.stringify(result));
    return result.result.structuredContent;
  };
  const created = await call();
  const running = f.control(
    "release",
    "--id",
    "switch-green",
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    baseline,
  );
  let maintenanceSeen = false;
  for (let n = 0; n < 600; n++) {
    const r = await fetch(f.origin + "/login");
    if (r.status === 503) {
      maintenanceSeen = true;
      assert.equal(r.headers.get("retry-after"), "60");
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(maintenanceSeen);
  for (const path of ["/api/diaries", "/public/test", "/mcp"])
    assert.equal((await fetch(f.origin + path)).status, 503);
  const result = await running;
  assert.equal(result.code, 0, result.output + result.error);
  const receipt = JSON.parse(result.output);
  assert.equal(receipt.actualCommit, target);
  assert.equal(receipt.slot, "green");
  const replayed = await call();
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.diary.id, created.diary.id);
  assert.ok(receipt.mayHaveOpenedAt && receipt.maintenanceMilliseconds > 0);
  assert.equal(
    run(
      "systemctl",
      "show",
      f.config.unit,
      "--property=MainPID",
      "--value",
    ).trim(),
    "0",
  );
  assert.equal(
    run("systemctl", "is-active", f.config.slots.green.unit).trim(),
    "active",
  );
  assert.deepEqual(
    await fetch(f.origin + "/health/ready").then((r) => r.json()),
    { ready: true, version: target },
  );
  assert.equal(
    (
      await fetch(f.origin + "/internal/health", {
        headers: {
          "X-Daily-Health": "isolated_health_token_012345678901234567890",
        },
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
  assert.equal(
    await f.request(`/api/attachments/${f.attachment}`, undefined, true),
    "original attachment bytes",
  );
  assert.equal(
    JSON.parse(
      await readFile(`${f.root}/backups/switch-green/manifest.json`, "utf8"),
    ).commit,
    baseline,
  );
  const retry = await f.control(
    "release",
    "--id",
    "switch-green",
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    baseline,
  );
  assert.deepEqual(JSON.parse(retry.output), receipt);
});
