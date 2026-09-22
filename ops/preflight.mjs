// A candidate may initialize/migrate its disposable database; it never receives
// the live configuration, environment, data directory or production credentials.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, chown } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";

const runtime = resolve(process.argv[2]),
  commit = process.argv[3];
const directory = await mkdtemp(resolve(tmpdir(), "daily-preflight-"));
const user = process.argv[4];
assert.match(user ?? "", /^[a-z_][a-z0-9_-]*$/);
const uid = Number(
  execFileSync("/usr/bin/id", ["-u", user], { encoding: "utf8" }).trim(),
);
const gid = Number(
  execFileSync("/usr/bin/id", ["-g", user], { encoding: "utf8" }).trim(),
);
assert.ok(
  uid > 0 && Number.isInteger(uid) && Number.isInteger(gid),
  "PREFLIGHT_REQUIRES_UNPRIVILEGED_USER",
);
await chown(directory, uid, gid);
const reservation = createServer().listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const child = spawn(process.execPath, ["build/server/main.js"], {
  cwd: runtime,
  uid,
  gid,
  env: {
    PATH: process.env.PATH,
    HOME: directory,
    NODE_ENV: "production",
    PORT: String(port),
    DAILY_DATABASE_PATH: resolve(directory, "preflight.sqlite"),
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
  const read = (path, options = {}) => {
    assert.ok(Date.now() < deadline, "ISOLATED_PREFLIGHT_TIMEOUT");
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...options,
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(2000, deadline - Date.now())),
      ),
    });
  };
  let ready = false;
  while (Date.now() < deadline && !finished) {
    try {
      const r = await read("/health/ready");
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
    (await read("/api/setup/status").then((r) => r.json())).needsSetup,
    true,
  );
  assert.equal((await read("/login")).status, 200);
  assert.equal(
    (await read("/.well-known/oauth-authorization-server")).status,
    200,
  );
  assert.equal((await read("/mcp", { method: "POST" })).status, 401);
} finally {
  if (!finished) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 28000);
    await exited;
    clearTimeout(timer);
  }
  await rm(directory, { recursive: true, force: true });
}
