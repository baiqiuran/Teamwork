import assert from "node:assert/strict";
import { read as fetch } from "./http.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, rm, access, statfs } from "node:fs/promises";
import { resolve, isAbsolute, sep } from "node:path";
import { json, durable, syncPath } from "./io.mjs";
import { bootId } from "./process-identity.mjs";

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
export function probeHeaders(config) {
  const origin = new URL(config.recoveryPublicUrl ?? config.ingressUrl);
  return {
    Host: origin.host,
    "X-Forwarded-Proto": origin.protocol.slice(0, -1),
  };
}
export async function configuration(path, readRuntime = true) {
  assert.equal(process.platform, "linux", "Deployment control requires Linux");
  const config = await json(path);
  assert.equal(config.schema, 1);
  assert.ok(
    config.backupMode === undefined ||
      ["local", "oss"].includes(config.backupMode),
    "INVALID_BACKUP_MODE",
  );
  if (config.backupMode === "oss") assert.ok(config.oss, "OSS_NOT_CONFIGURED");
  if (
    readRuntime &&
    typeof config.stateDir === "string" &&
    isAbsolute(config.stateDir) &&
    (await exists(resolve(config.stateDir, "runtime.json")))
  ) {
    const runtime = await json(resolve(config.stateDir, "runtime.json"));
    config.artifact = runtime.artifact;
    if (runtime.slot && config.slots) {
      config.activeSlot = runtime.slot;
      config.unit = config.slots[runtime.slot].unit;
      config.probeUrl = `http://127.0.0.1:${config.slots[runtime.slot].port}/api/setup/status`;
    }
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
  if (config.recoveryPublicUrl) {
    assert.equal(config.recoveryMode, "isolated");
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(
        new URL(config.ingressUrl).hostname,
      ),
    );
    assert.equal(
      new URL(config.recoveryPublicUrl).origin,
      config.recoveryPublicUrl,
    );
    assert.equal(new URL(config.recoveryPublicUrl).protocol, "https:");
  }
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
    headers: probeHeaders(config),
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
export async function stop(config) {
  // Revoke before stopping: once the data lock is released, this slot must
  // not reopen a restored database using a permit from the previous stage.
  if (config.slots) {
    await rm(resolve(config.stateDir, "owner.json"), { force: true });
    await syncPath(config.stateDir);
  }
  command("/bin/systemctl", "stop", config.unit);
  assertStopped(config.unit);
}
export function assertStopped(unit) {
  assert.equal(
    command(
      "/bin/systemctl",
      "show",
      unit,
      "--property=MainPID",
      "--value",
    ).trim(),
    "0",
    "OLD_PROCESS_STILL_RUNNING",
  );
  const active = command(
    "/bin/systemctl",
    "show",
    unit,
    "--property=ActiveState",
    "--value",
  ).trim();
  assert.ok(["inactive", "failed"].includes(active), "OLD_SERVICE_NOT_STOPPED");
}
export async function start(config, deadline = Date.now() + 120000) {
  if (config.slots) {
    const manifest = await json(
      resolve(config.slots[config.activeSlot].link, "release.json"),
    );
    await durable(resolve(config.stateDir, "owner.json"), {
      slot: config.activeSlot,
      commit: manifest.commit,
      bootId: await bootId(),
    });
  }
  command("/bin/systemctl", "start", config.unit);
  while (Date.now() < deadline) {
    if (
      command(
        "/bin/systemctl",
        "show",
        config.unit,
        "--property=ActiveState",
        "--value",
      ).trim() === "failed"
    )
      throw new Error("STARTUP_FAILED: application service exited");
    try {
      const response = await fetch(config.probeUrl, {
        signal: AbortSignal.timeout(2000),
        headers: probeHeaders(config),
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
