import assert from "node:assert/strict";
import { test } from "node:test";
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

const run = (command, ...args) =>
  execFileSync(command, args, { encoding: "utf8" });
async function port() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const result = server.address().port;
  await new Promise((done) => server.close(done));
  return result;
}
async function fixture() {
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
        Origin: origin,
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

test("consistent backup, real maintenance, matched restore and corruption refusal", async (t) => {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  const backup = await f.control(
    "backup",
    "--id",
    "baseline",
    "--kind",
    "daily",
  );
  assert.equal(backup.code, 0, backup.error);
  assert.equal(JSON.parse(backup.output).phase, "completed");
  const snapshot = JSON.parse(
    await readFile(`${f.root}/backups/baseline/manifest.json`, "utf8"),
  );
  assert.match(snapshot.commit, /^[a-f0-9]{40}$/);
  await writeFile(
    `${f.root}/deploy.json`,
    JSON.stringify({ ...f.config, reserveBytes: Number.MAX_SAFE_INTEGER }),
  );
  const noSpace = await f.control(
    "restore",
    "--id",
    "no-space",
    "--snapshot",
    "baseline",
  );
  assert.notEqual(noSpace.code, 0);
  assert.match(noSpace.output, /INSUFFICIENT_DISK/);
  assert.equal(JSON.parse(noSpace.output).recovery, "not-needed");
  assert.ok(
    !(await readdir(`${f.root}/control`)).some((name) =>
      name.startsWith(".validated-"),
    ),
  );
  assert.equal((await fetch(`${f.origin}/login`)).status, 200);
  await writeFile(`${f.root}/deploy.json`, JSON.stringify(f.config));
  const newDiary = await f.request("/api/diaries", {
    title: "恢复时应移除",
    entries: [],
  });
  await writeFile(
    `${f.root}/data/attachments/${f.attachment}`,
    "changed bytes",
  );
  const restored = await f.control(
    "restore",
    "--id",
    "restore-baseline",
    "--snapshot",
    "baseline",
  );
  assert.equal(restored.code, 0, restored.error);
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
  assert.equal(
    await f.request(`/api/attachments/${f.attachment}`, undefined, true),
    "original attachment bytes",
  );
  assert.ok(
    !(await f.request("/api/diaries/mine")).some(
      (diary) => diary.id === newDiary.id,
    ),
  );
  await writeFile(
    `${f.root}/backups/baseline/data.tar.gz`,
    "corrupted archive",
  );
  const rejected = await f.control(
    "restore",
    "--id",
    "reject-corrupt",
    "--snapshot",
    "baseline",
  );
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.error + rejected.output, /SNAPSHOT_CHECKSUM/);
  assert.equal(
    await f.request(`/api/attachments/${f.attachment}`, undefined, true),
    "original attachment bytes",
  );
  run("systemctl", "stop", `${f.id}.service`);
});

test("a delayed duplicate returns the completed receipt after acquiring the lock", async (t) => {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  const hook = `${f.root}/pause-lock.mjs`;
  await writeFile(
    hook,
    `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.open;
fs.open = async function(path, ...args) {
  if (String(path).endsWith('/operation.lock')) {
    await fs.writeFile(${JSON.stringify(`${f.root}/paused`)}, 'ready');
    while (true) { try { await fs.access(${JSON.stringify(`${f.root}/resume`)}); break; } catch { await new Promise(r => setTimeout(r, 20)); } }
  }
  return original.call(this, path, ...args);
};
syncBuiltinESMExports();`,
  );
  const delayed = f.controlWith(
    ["--import", hook],
    "backup",
    "--id",
    "same-request",
  );
  for (let i = 0; i < 100; i++) {
    try {
      await access(`${f.root}/paused`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  await access(`${f.root}/paused`);
  const first = await f.control("backup", "--id", "same-request");
  assert.equal(first.code, 0, first.output + first.error);
  await writeFile(`${f.root}/resume`, "resume");
  const second = await delayed;
  assert.equal(second.code, 0, second.output + second.error);
  assert.deepEqual(JSON.parse(second.output), JSON.parse(first.output));
});

test("maintenance blocks every entrance and concurrent data operations cannot steal control", async (t) => {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  const first = f.control("backup", "--id", "owner");
  let maintenanceSeen = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await fetch(`${f.origin}/login`);
    if (response.status === 503) {
      maintenanceSeen = true;
      assert.equal(response.headers.get("retry-after"), "60");
      break;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.ok(
    maintenanceSeen,
    "Real proxy must enter maintenance before stopping data writes",
  );
  const competing = await f.control("backup", "--id", "contender");
  assert.notEqual(competing.code, 0);
  assert.match(competing.output, /OPERATION_BUSY/);
  for (const path of ["/api/diaries", "/public/example", "/mcp"])
    assert.equal(
      (await fetch(f.origin + path, { method: "POST" })).status,
      503,
    );
  const result = await first;
  assert.equal(result.code, 0, result.output + result.error);
  const status = await f.control("status", "--id", "owner");
  assert.equal(JSON.parse(status.output).phase, "completed");
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
});

test("invalid local bytes or insufficient disk do not produce usable snapshots and restart the original service", async (t) => {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  await writeFile(`${f.root}/data/attachments/${f.attachment}`, "wrong bytes");
  const failed = await f.control("backup", "--id", "invalid-bytes");
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /ATTACHMENT_(SIZE|BYTES)_MISMATCH/);
  assert.equal(JSON.parse(failed.output).recovery, "original-service-restored");
  assert.equal((await fetch(`${f.origin}/api/setup/status`)).status, 200);
  await assert.rejects(
    readFile(`${f.root}/backups/invalid-bytes/manifest.json`),
  );
  await writeFile(
    `${f.root}/data/attachments/${f.attachment}`,
    "original attachment bytes",
  );
  await writeFile(
    `${f.root}/deploy.json`,
    JSON.stringify({ ...f.config, reserveBytes: Number.MAX_SAFE_INTEGER }),
  );
  const full = await f.control("backup", "--id", "disk-full");
  assert.notEqual(full.code, 0);
  assert.match(full.output, /INSUFFICIENT_DISK/);
  assert.equal((await fetch(`${f.origin}/api/setup/status`)).status, 200);
  assert.equal(
    await f.request(`/api/attachments/${f.attachment}`, undefined, true),
    "original attachment bytes",
  );
});
