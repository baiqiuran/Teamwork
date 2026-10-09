import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
const launcher = resolve("scripts/local-service.mjs");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "daily-local-service-"));
  const listener = net.createServer();
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  await mkdir(join(root, "build/server"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "database-sentinel"), "untouched");
  await writeFile(
    join(root, "build/server/main.js"),
    `import http from 'node:http';import {existsSync} from 'node:fs';console.log('fixture stdout');console.error('fixture stderr');while(!existsSync('listen'))await new Promise(r=>setTimeout(r,20));http.createServer((q,r)=>{r.statusCode=existsSync('ready')?200:503;r.end(JSON.stringify({ready:existsSync('ready'),version:'fixture'}));}).listen(${port},'127.0.0.1');`,
  );
  const env = {
    ...process.env,
    PORT: String(port),
    DAILY_LOCAL_RUN_DIR: join(root, "runs"),
  };
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.send("shutdown");
      await new Promise((r) => child.once("exit", r));
    }
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  const status = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, [launcher, "status", ...args], {
        cwd: root,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 20000,
      }),
    );
  const start = async (listen = true) => {
    if (listen) await writeFile(join(root, "listen"), "");
    child = spawn(process.execPath, [launcher, "start"], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    await until(async () => {
      if (child.exitCode !== null) throw Error(output);
      try {
        return (
          await readFile(
            join(root, "runs", String(port), "service.json"),
            "utf8",
          )
        ).includes("processIdentity");
      } catch {
        return false;
      }
    });
  };
  return {
    root,
    port,
    env,
    status,
    start,
    stop: async () => {
      child.send("shutdown");
      await new Promise((r) => child.once("exit", r));
    },
  };
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("fixture condition timeout");
}
test("local status distinguishes pending, ready, exited and leaves database/logs intact", async (t) => {
  const f = await fixture(t);
  assert.equal(f.status().local.state, "not-started");
  await f.start(false);
  assert.equal(f.status().local.state, "starting");
  await writeFile(join(f.root, "listen"), "");
  await until(() => f.status().local.state === "not-ready");
  await writeFile(join(f.root, "ready"), "");
  const ready = f.status();
  assert.equal(ready.local.state, "running");
  assert.ok(ready.local.pid && ready.local.startedAt);
  assert.match(
    await readFile(ready.local.logs.stdout, "utf8"),
    /fixture stdout/,
  );
  assert.match(
    await readFile(ready.local.logs.stderr, "utf8"),
    /fixture stderr/,
  );
  assert.equal(ready.public, undefined);
  const checked = f.status("--public-url", `http://127.0.0.1:${f.port}`);
  assert.equal(checked.local.state, "running");
  assert.equal(checked.public.ready, true);
  await f.stop();
  assert.equal(f.status().local.state, "exited");
  assert.equal(
    await readFile(join(f.root, "database-sentinel"), "utf8"),
    "untouched",
  );
});
test("local status identifies another listener and reused process identity without killing it", async (t) => {
  const f = await fixture(t);
  await f.start();
  const recordPath = join(f.root, "runs", String(f.port), "service.json");
  const original = JSON.parse(await readFile(recordPath, "utf8"));
  await writeFile(
    recordPath,
    JSON.stringify({ ...original, processIdentity: "old-process-birth" }),
  );
  assert.equal(f.status().local.state, "pid-reused");
  await writeFile(recordPath, JSON.stringify(original));
  await f.stop();
  const listener = net.createServer();
  await new Promise((r) => listener.listen(f.port, "127.0.0.1", r));
  try {
    assert.equal(f.status().local.state, "port-occupied");
    assert.equal(listener.listening, true);
  } finally {
    await new Promise((r) => listener.close(r));
  }
});

for (const mode of ["start", "dev"]) {
  test(`real ${mode} uses isolated SQLite, exposes logs and releases its child processes`, async (t) => {
    const f = await fixture(t);
    const database = join(f.root, "isolated.sqlite");
    const env = { ...f.env, DAILY_DATABASE_PATH: database };
    const entry =
      mode === "start" ? resolve("build/server/local-service.mjs") : launcher;
    const child = spawn(process.execPath, [entry, mode], {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const stop = async () => {
      if (child.exitCode === null) {
        child.send("shutdown");
        await new Promise((r) => child.once("exit", r));
      }
    };
    t.after(stop);
    await until(async () => {
      if (child.exitCode !== null) throw Error(output);
      try {
        const response = await fetch(`http://127.0.0.1:${f.port}/health/ready`);
        return response.ok;
      } catch {
        return false;
      }
    });
    const before = createHash("sha256")
      .update(await readFile(database))
      .digest("hex");
    assert.equal(f.status().local.state, "running");
    assert.equal(
      createHash("sha256")
        .update(await readFile(database))
        .digest("hex"),
      before,
    );
    await stop();
    assert.equal(f.status().local.state, "exited");
    assert.equal(f.status().local.listenerPids.length, 0);
  });
}
