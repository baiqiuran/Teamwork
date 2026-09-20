import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, access, statfs } from "node:fs/promises";
import { resolve, isAbsolute, sep } from "node:path";
import { json, durable } from "./io.mjs";

export const command = (name, ...args) =>
  execFileSync(name, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
export const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
export async function configuration(path) {
  assert.equal(process.platform, "linux", "Deployment control requires Linux");
  const config = await json(path);
  assert.equal(config.schema, 1);
  if (
    typeof config.stateDir === "string" &&
    isAbsolute(config.stateDir) &&
    (await exists(resolve(config.stateDir, "runtime.json")))
  ) {
    config.artifact = (
      await json(resolve(config.stateDir, "runtime.json"))
    ).artifact;
  }
  for (const key of [
    "dataDir",
    "stateDir",
    "backupDir",
    "current",
    "releases",
    "envFile",
    "artifact",
    "maintenance",
    "dataLock",
  ]) {
    assert.ok(
      typeof config[key] === "string" &&
        isAbsolute(config[key]) &&
        resolve(config[key]) === config[key] &&
        config[key].split(sep).length >= 3,
      `Invalid configured path: ${key}`,
    );
  }
  for (const left of ["dataDir", "stateDir", "backupDir", "releases"])
    for (const right of ["dataDir", "stateDir", "backupDir", "releases"])
      if (left !== right)
        assert.ok(
          config[left] !== config[right] &&
            !config[left].startsWith(config[right] + sep),
          "Data, control, backup and releases must be separate",
        );
  assert.match(config.database, /^[a-zA-Z0-9_-]+\.sqlite$/);
  assert.match(config.unit, /^[a-zA-Z0-9@._-]+\.service$/);
  assert.match(config.serviceUser, /^[a-z_][a-z0-9_-]*$/);
  assert.ok(
    Number.isSafeInteger(config.reserveBytes) && config.reserveBytes >= 0,
  );
  assert.equal(new URL(config.probeUrl).hostname, "127.0.0.1");
  assert.ok(["http:", "https:"].includes(new URL(config.ingressUrl).protocol));
  for (const directory of [config.stateDir, config.backupDir])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(resolve(config.stateDir, "operations"), {
    recursive: true,
    mode: 0o700,
  });
  return config;
}
export async function capacity(config, required, stagingDirectories = []) {
  assert.ok(
    Number.isSafeInteger(required) && required >= 0,
    "INVALID_DISK_BUDGET",
  );
  for (const directory of new Set([
    config.dataDir,
    config.backupDir,
    config.releases,
    config.stateDir,
    ...stagingDirectories,
  ])) {
    const disk = await statfs(directory, { bigint: true });
    assert.ok(
      disk.bavail * disk.bsize >=
        BigInt(required) + BigInt(config.reserveBytes),
      "INSUFFICIENT_DISK: protected backups are not deleted to make space",
    );
  }
}
export async function maintenance(config, enabled) {
  if (enabled) await durable(config.maintenance, "maintenance\n", 0o644);
  else await rm(config.maintenance, { force: true });
  const response = await fetch(new URL("/login", config.ingressUrl), {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(
    response.status,
    enabled ? 503 : 200,
    "PROXY_MAINTENANCE_MISMATCH",
  );
  if (enabled)
    assert.ok(
      Number(response.headers.get("retry-after")) > 0,
      "MAINTENANCE_RETRY_HEADER_MISSING",
    );
}
export function stop(config) {
  command("/bin/systemctl", "stop", config.unit);
  assert.equal(
    command(
      "/bin/systemctl",
      "show",
      config.unit,
      "--property=MainPID",
      "--value",
    ).trim(),
    "0",
    "OLD_PROCESS_STILL_RUNNING",
  );
  const active = command(
    "/bin/systemctl",
    "show",
    config.unit,
    "--property=ActiveState",
    "--value",
  ).trim();
  assert.ok(["inactive", "failed"].includes(active), "OLD_SERVICE_NOT_STOPPED");
}
export async function start(config) {
  command("/bin/systemctl", "start", config.unit);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(config.probeUrl, {
        signal: AbortSignal.timeout(2000),
        headers: {
          Host: new URL(config.ingressUrl).host,
          "X-Forwarded-Proto": new URL(config.ingressUrl).protocol.slice(0, -1),
        },
      });
      if (
        response.status === 200 &&
        (await response.json()).needsSetup === false
      )
        return;
    } catch {
      /* A just-started process may not be listening yet. */
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(
    "STARTUP_TIMEOUT: service did not validate within 120 seconds",
  );
}
