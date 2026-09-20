// A candidate may initialize/migrate its disposable database; it never receives
// the live configuration, environment, data directory or production credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

const runtime = resolve(process.argv[2]),
  commit = process.argv[3];
const directory = await mkdtemp(resolve(tmpdir(), "daily-preflight-"));
const reservation = createServer().listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const child = spawn(process.execPath, ["build/server/main.js"], {
  cwd: runtime,
  env: {
    PATH: process.env.PATH,
    HOME: directory,
    NODE_ENV: "production",
    PORT: String(port),
    DAILY_DATABASE_PATH: resolve(directory, "preflight.sqlite"),
    DAILY_SETUP_KEY: randomBytes(32).toString("hex"),
  },
  stdio: "ignore",
});
const exited = once(child, "exit");
let finished = false;
child.once("exit", () => {
  finished = true;
});
try {
  const deadline = Date.now() + 120000;
  let ready = false;
  while (Date.now() < deadline && !finished) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health/ready`, {
        signal: AbortSignal.timeout(1000),
      });
      const body = await r.json();
      ready = r.ok && body.ready === true && body.version === commit;
      if (ready) break;
    } catch {
      /* Wait for the isolated process to bind. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, "ISOLATED_PREFLIGHT_FAILED");
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/api/setup/status`).then((r) =>
        r.json(),
      )
    ).needsSetup,
    true,
  );
  assert.equal((await fetch(`http://127.0.0.1:${port}/login`)).status, 200);
  assert.equal(
    (
      await fetch(
        `http://127.0.0.1:${port}/.well-known/oauth-authorization-server`,
      )
    ).status,
    200,
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" })).status,
    401,
  );
} finally {
  if (!finished) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 28000);
    await exited;
    clearTimeout(timer);
  }
  await rm(directory, { recursive: true, force: true });
}
