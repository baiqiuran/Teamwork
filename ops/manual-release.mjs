import assert from "node:assert/strict";
import {
  mkdir,
  cp,
  rename,
  symlink,
  readFile,
  open,
  stat,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { json, durable, sha256, syncPath } from "./io.mjs";
import {
  capacity,
  command,
  maintenance,
  start,
  stop,
  probeHeaders,
} from "./host.mjs";
import { archiveSize, extract } from "./snapshots.mjs";
import { freeze } from "./recovery.mjs";
import { read } from "./http.mjs";

const checks = ["architecture", "types", "build", "production-startup"];
const statePath = (config, operation) =>
  resolve(config.stateDir, "operations", `${operation.id}.json`);

async function prepare(config, operation) {
  assert.ok(!config.slots, "SINGLE_INSTANCE_REQUIRED");
  assert.equal(
    command(
      "/bin/systemctl",
      "show",
      config.unit,
      "--property=Restart",
      "--value",
    ).trim(),
    "no",
    "AUTOMATIC_RESTART_FORBIDDEN",
  );
  const current = await json(resolve(config.current, "release.json"));
  const runtime = await json(resolve(config.stateDir, "runtime.json"));
  assert.equal(current.commit, operation.baseline, "BASELINE_CHANGED");
  assert.equal(runtime.commit, operation.baseline, "RUNTIME_IDENTITY_MISMATCH");
  const receipt = await json(resolve(operation.candidate, "receipt.json"));
  const archive = resolve(operation.candidate, "application.tar.gz");
  assert.equal(await sha256(archive), receipt.sha256, "ARTIFACT_CHECKSUM");
  assert.equal(receipt.schema, 1, "INVALID_RECEIPT");
  assert.equal(receipt.mode, "manual", "INVALID_RECEIPT");
  assert.match(receipt.commit, /^[a-f0-9]{40}$/);
  assert.equal(receipt.baseline, operation.baseline, "BASELINE_CHANGED");
  assert.equal(receipt.node, process.version, "RUNTIME_MISMATCH");
  assert.equal(receipt.platform, process.platform, "PLATFORM_MISMATCH");
  assert.equal(receipt.architecture, process.arch, "ARCHITECTURE_MISMATCH");
  assert.deepEqual(receipt.checks, checks, "INVALID_RECEIPT_CHECKS");
  assert.ok(
    Number.isSafeInteger(receipt.expectedSchema) && receipt.expectedSchema > 0,
    "EXPECTED_SCHEMA_REQUIRED",
  );
  assert.ok(
    Array.isArray(receipt.migration?.paths),
    "MIGRATION_CONFIRMATION_REQUIRED",
  );
  assert.ok(
    receipt.migration.paths.length === 0 ||
      receipt.migration.confirmed === true,
    "MIGRATION_CONFIRMATION_REQUIRED",
  );
  const old = await criteria(config, operation.baseline);
  await capacity(config, archiveSize(archive) * 2);
  const release = resolve(config.releases, `${receipt.commit}-${operation.id}`);
  await mkdir(release, { mode: 0o755 });
  extract(archive, release);
  command("/bin/chmod", "-R", "a-s,a+rX", release);
  const manifest = await json(resolve(release, "release.json"));
  for (const name of [
    "schema",
    "mode",
    "commit",
    "node",
    "platform",
    "architecture",
    "expectedSchema",
  ])
    assert.deepEqual(manifest[name], receipt[name], "MANIFEST_MISMATCH");
  const artifact = resolve(release, "application.tar.gz");
  await cp(archive, artifact);
  await syncPath(artifact);
  command(
    process.execPath,
    fileURLToPath(new URL("./preflight.mjs", import.meta.url)),
    release,
    receipt.commit,
    config.serviceUser,
    String(receipt.expectedSchema),
  );
  return {
    release,
    artifact,
    commit: receipt.commit,
    expectedSchema: receipt.expectedSchema,
    sha256: receipt.sha256,
    oldCommit: current.commit,
    oldSchema: old.schema,
    oldArtifact: config.artifact,
  };
}

export async function criteria(config, commit, schema) {
  assert.equal(
    command(
      "/bin/systemctl",
      "show",
      config.unit,
      "--property=ActiveState",
      "--value",
    ).trim(),
    "active",
    "PROCESS_NOT_ACTIVE",
  );
  const token = (await readFile(config.healthTokenFile, "utf8")).trim();
  assert.ok(token.length >= 32, "HEALTH_TOKEN_TOO_SHORT");
  const get = (path, headers = {}) =>
    read(new URL(path, config.probeUrl), {
      headers: { ...probeHeaders(config), ...headers },
      signal: AbortSignal.timeout(5000),
    });
  const ready = await get("/health/ready");
  assert.equal(ready.status, 200, "READINESS_FAILED");
  assert.deepEqual(
    await ready.json(),
    { ready: true, version: commit },
    "WRONG_RUNNING_VERSION",
  );
  const health = await get("/internal/health", { "X-Daily-Health": token });
  assert.equal(health.status, 200, "LOCAL_HEALTH_FAILED");
  const detail = await health.json();
  assert.equal(detail.version, commit, "WRONG_RUNNING_VERSION");
  assert.equal(detail.integrity, "ok", "SQLITE_INTEGRITY_FAILED");
  assert.equal(detail.initialized, true, "EXISTING_TEAM_MISSING");
  assert.equal(
    detail.attachmentsAccessible,
    true,
    "ATTACHMENT_STORAGE_UNAVAILABLE",
  );
  if (schema !== undefined)
    assert.equal(detail.schema, schema, "SCHEMA_MISMATCH");
  const page = await get("/login");
  assert.equal(page.status, 200, "READ_ONLY_PAGE_FAILED");
  const html = await page.text();
  assert.match(html, /<div id="root"><\/div>/, "READ_ONLY_PAGE_FAILED");
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(assets.length > 0, "PAGE_ASSETS_MISSING");
  for (const asset of assets) {
    const response = await get(asset);
    assert.equal(response.status, 200, "PAGE_ASSET_FAILED");
    assert.doesNotMatch(
      response.headers.get("content-type") ?? "",
      /text\/html/,
      "PAGE_ASSET_FAILED",
    );
    assert.ok((await response.text()).length > 0, "PAGE_ASSET_FAILED");
  }
  return {
    processActive: true,
    ready: true,
    version: commit,
    schema: detail.schema,
    integrity: detail.integrity,
    attachmentsAccessible: true,
    readOnlyPage: true,
    checkedAt: new Date().toISOString(),
  };
}

async function publicReady(config, commit) {
  const response = await read(new URL("/health/ready", config.ingressUrl), {
    headers: probeHeaders(config),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, "PUBLIC_READINESS_FAILED");
  assert.deepEqual(
    await response.json(),
    { ready: true, version: commit },
    "PUBLIC_VERSION_MISMATCH",
  );
}

async function logPosition(config) {
  assert.ok(
    typeof config.manualAccessLog === "string" &&
      config.manualAccessLog.startsWith("/"),
    "ACCESS_LOG_REQUIRED",
  );
  const file = await stat(config.manualAccessLog);
  assert.ok(file.isFile(), "INVALID_ACCESS_LOG");
  return {
    bytes: file.size,
    ino: file.ino,
    dev: file.dev,
    at: new Date().toISOString(),
  };
}

async function errorResponses(config, cursor) {
  const file = await open(config.manualAccessLog, "r");
  try {
    const current = await file.stat();
    assert.ok(
      current.ino === cursor.ino &&
        current.dev === cursor.dev &&
        current.size >= cursor.bytes,
      "ACCESS_LOG_ROTATED",
    );
    const length = current.size - cursor.bytes;
    assert.ok(length <= 4194304, "ACCESS_LOG_WINDOW_TOO_LARGE");
    const bytes = Buffer.alloc(length);
    const result = await file.read(bytes, 0, length, cursor.bytes);
    assert.equal(result.bytesRead, length, "ACCESS_LOG_TRUNCATED");
    const text = bytes.toString("utf8");
    assert.ok(!text || text.endsWith("\n"), "ACCESS_LOG_INCOMPLETE");
    const records = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    let errors = 0;
    for (const item of records) {
      assert.ok(
        Number.isInteger(item.status) &&
          item.status >= 100 &&
          item.status < 600 &&
          typeof item.upstream === "string" &&
          typeof item.retryAfter === "string",
        "INVALID_ACCESS_LOG",
      );
      const maintenanceResponse =
        item.status === 503 &&
        ["", "-"].includes(item.upstream) &&
        item.retryAfter === "60";
      if (item.status >= 500 && !maintenanceResponse) errors++;
    }
    assert.equal(errors, 0, "ERROR_RESPONSE_INCREASE");
    return {
      errors,
      requests: records.length,
      from: cursor.at,
      to: new Date().toISOString(),
    };
  } finally {
    await file.close();
  }
}

export async function recoverManual(configPath, config, operation) {
  assert.ok(
    !operation.mayHaveOpenedAt && !operation.recoveryOpeningAt,
    "RESTORE_AFTER_OPEN_FORBIDDEN",
  );
  assert.ok(
    ["stopping", "data-operation", "data-ready", "activating"].includes(
      operation.phase,
    ),
    "UNKNOWN_OR_INTERRUPTED_DATA_RESTORE",
  );
  await maintenance(config, true);
  await stop(config);
  if (operation.localBackup === "verified") {
    operation = {
      ...operation,
      phase: "rolling-back",
      recoveryId: randomUUID(),
    };
    await durable(statePath(config, operation), operation);
    command(
      "/usr/bin/flock",
      "--nonblock",
      config.dataLock,
      process.execPath,
      fileURLToPath(new URL("./data-worker.mjs", import.meta.url)),
      resolve(configPath),
      operation.id,
      "rollback",
    );
    operation = await json(statePath(config, operation));
  } else {
    assert.ok(
      ["stopping", "data-operation"].includes(operation.phase),
      "VERIFIED_SNAPSHOT_REQUIRED",
    );
    assert.equal(
      (await json(resolve(config.current, "release.json"))).commit,
      operation.baseline,
      "BASELINE_CHANGED",
    );
  }
  await start(config);
  const recoveryCriteria = await criteria(
    config,
    operation.baseline,
    operation.target.oldSchema,
  );
  operation = {
    ...operation,
    recoveryCriteria,
    phase: "rollback-may-be-open",
    recoveryOpeningAt: new Date().toISOString(),
  };
  await durable(statePath(config, operation), operation);
  await maintenance(config, false);
  await publicReady(config, operation.baseline);
  return {
    ...operation,
    actualCommit: operation.baseline,
    recovery: "baseline-restored",
  };
}

export async function manualRelease(configPath, config, operation) {
  let entered = false;
  const save = async (patch) => {
    operation = { ...operation, ...patch };
    await durable(statePath(config, operation), operation);
  };
  try {
    const target = await prepare(config, operation);
    await save({
      target,
      commit: target.commit,
      artifactSha256: target.sha256,
      expectedSchema: target.expectedSchema,
      logCursor: await logPosition(config),
    });
    entered = true;
    await save({ phase: "stopping", maintenanceAt: new Date().toISOString() });
    await maintenance(config, true);
    await stop(config);
    await save({
      phase: "data-operation",
      stoppedAt: new Date().toISOString(),
    });
    command(
      "/usr/bin/flock",
      "--nonblock",
      config.dataLock,
      process.execPath,
      fileURLToPath(new URL("./data-worker.mjs", import.meta.url)),
      resolve(configPath),
      operation.id,
    );
    operation = await json(statePath(config, operation));
    await save({ phase: "activating" });
    const next = `${config.current}.${operation.id}`;
    await symlink(target.release, next);
    await rename(next, config.current);
    await syncPath(dirname(config.current));
    await durable(resolve(config.stateDir, "runtime.json"), {
      commit: target.commit,
      artifact: target.artifact,
    });
    const deadline = Date.parse(operation.maintenanceAt) + 180000;
    await start(config, deadline);
    await save({
      criteria: {
        ...(await criteria(config, target.commit, target.expectedSchema)),
        errorResponses: await errorResponses(config, operation.logCursor),
      },
    });
    assert.ok(Date.now() < deadline, "MAINTENANCE_BUDGET_EXCEEDED");
    await save({
      phase: "may-be-open",
      mayHaveOpenedAt: new Date().toISOString(),
    });
    await maintenance(config, false);
    await publicReady(config, target.commit);
    await save({
      criteria: {
        ...operation.criteria,
        errorResponses: await errorResponses(config, operation.logCursor),
      },
    });
    await save({
      phase: "completed",
      actualCommit: target.commit,
      maintenanceMilliseconds: Date.now() - Date.parse(operation.maintenanceAt),
      maintenanceBudgetMilliseconds: 180000,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    operation = await json(statePath(config, operation));
    let recovery = "not-needed";
    if (entered && !operation.mayHaveOpenedAt && !operation.recoveryOpeningAt) {
      try {
        operation = await recoverManual(configPath, config, operation);
        recovery = operation.recovery;
      } catch (restoreError) {
        operation = await json(statePath(config, operation));
        operation.recoveryFailure = restoreError.message;
        recovery = "manual-intervention";
      }
    } else if (entered) recovery = "preserved-new-data";
    await freeze(
      config,
      operation,
      error.message,
      entered && recovery !== "baseline-restored",
    );
    await save({
      phase: "failed",
      failure: error.message,
      recovery,
      maintenanceMilliseconds: operation.maintenanceAt
        ? Date.now() - Date.parse(operation.maintenanceAt)
        : undefined,
      nextAction:
        "Inspect current version and data, then resolve-incident explicitly; do not delete locks or replay this ID.",
      finishedAt: new Date().toISOString(),
    });
  }
  return operation;
}
