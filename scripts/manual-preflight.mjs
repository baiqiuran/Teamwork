import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

const exec = promisify(execFile);

/** Allowlist instead of deleting a few known credentials. No dotenv, user npm
 * config, NODE_OPTIONS, DAILY_*, cloud tokens, SSH agent or inherited npm config. */
export function isolatedEnvironment({ runtimeNode, home } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      [
        "path",
        "systemroot",
        "windir",
        "comspec",
        "pathext",
        "temp",
        "tmp",
      ].includes(key.toLowerCase())
    )
      env[key] = value;
  }
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  if (runtimeNode)
    env[pathKey] = `${dirname(runtimeNode)}${delimiter}${env[pathKey] ?? ""}`;
  if (home)
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      npm_config_userconfig: resolve(home, "user.npmrc"),
      npm_config_globalconfig: resolve(home, "global.npmrc"),
      npm_config_cache: resolve(home, "npm-cache"),
    });
  return env;
}

export async function localNodeVersion(runtimeNode) {
  try {
    const { stdout } = await exec(runtimeNode, ["--version"], {
      env: isolatedEnvironment({ runtimeNode }),
      windowsHide: true,
      timeout: 10000,
    });
    if (!/^v\d+\.\d+\.\d+$/.test(stdout.trim())) throw new Error();
    return stdout.trim();
  } catch {
    throw new Error(
      "LOCAL_NODE_INVALID: runtimeNode must be a locally executable Node binary (Windows binary on Windows, not the Linux production binary)",
    );
  }
}

/** Readiness and deep health only. All application writes are confined to a new
 * disposable database; initialized:false is the correct result for that DB. */
export async function startupPreflight({
  runtime,
  runtimeNode,
  node,
  commit,
  timeoutMs = 60000,
}) {
  if ((await localNodeVersion(runtimeNode)) !== node)
    throw new Error(
      "NODE_VERSION_MISMATCH: local runtime must match the captured production version exactly",
    );
  const directory = await mkdtemp(resolve(tmpdir(), "manual-startup-"));
  let child, closed;
  try {
    const reservation = createServer();
    await new Promise((done, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", done);
    });
    const port = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    const token = randomBytes(32).toString("hex");
    child = spawn(runtimeNode, ["build/server/main.js"], {
      cwd: runtime,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...isolatedEnvironment({ runtimeNode, home: directory }),
        NODE_ENV: "production",
        PORT: String(port),
        DAILY_DATABASE_PATH: resolve(directory, "fresh.sqlite"),
        DAILY_HEALTH_TOKEN: token,
      },
    });
    let stopped = false;
    closed = new Promise((done) => {
      child.once("error", () => {
        stopped = true;
        done();
      });
      child.once("close", () => {
        stopped = true;
        done();
      });
    });
    const origin = `http://127.0.0.1:${port}`;
    const request = async (path) => {
      const response = await fetch(origin + path, {
        headers: { "X-Daily-Health": token },
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      });
      if (response.status !== 200) throw new Error("unready");
      return response.json();
    };
    const deadline = Date.now() + timeoutMs;
    let ready;
    while (Date.now() < deadline) {
      if (stopped)
        throw new Error(
          "STARTUP_FAILED: production process exited before readiness",
        );
      ready = await request("/health/ready").catch(() => null);
      if (ready?.ready === true) break;
      await wait(150);
    }
    if (ready?.ready !== true)
      throw new Error("STARTUP_TIMEOUT: readiness was not reached");
    if (ready.version !== commit) throw new Error("STARTUP_VERSION_MISMATCH");
    const health = await request("/internal/health").catch(() => null);
    if (
      stopped ||
      health?.ready !== true ||
      health.version !== commit ||
      !Number.isSafeInteger(health.schema) ||
      health.schema < 0 ||
      health.integrity !== "ok" ||
      health.initialized !== false ||
      health.attachmentsAccessible !== true
    )
      throw new Error(
        "STARTUP_HEALTH_FAILED: expected an intact, uninitialized fresh database with accessible attachments",
      );
    return { expectedSchema: health.schema };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      const exited = await Promise.race([
        closed.then(() => true),
        wait(5000, false, { ref: false }),
      ]);
      if (!exited) {
        child.kill("SIGKILL");
        await closed;
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
