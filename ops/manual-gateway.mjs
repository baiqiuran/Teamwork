// Manual forced-command boundary: only public facts leave this module.
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  lstat,
  rename,
  rm,
  chmod,
  readdir,
} from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { json, sha256, durable, syncPath } from "./io.mjs";
import { exists, probeHeaders, capacity, command } from "./host.mjs";
import { read } from "./http.mjs";
import { archiveSize, extract } from "./snapshots.mjs";
import { alive } from "./process-identity.mjs";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const PUBLIC_ERRORS = new Set([
  "BASELINE_DISCREPANCY",
  "READINESS_FAILED",
  "REMOTE_COMMAND_NOT_ALLOWED",
  "MANUAL_SINGLE_INSTANCE_REQUIRED",
  "INCOMING_PATH_REQUIRED",
  "UNSAFE_INCOMING",
  "UPLOAD_ID_CONFLICT",
  "UPLOAD_DIGEST_MISMATCH",
  "UPLOAD_TOO_LARGE",
  "INVALID_MANUAL_RECEIPT",
  "ARTIFACT_CHECKSUM",
  "INVALID_MANUAL_BUNDLE",
  "INSUFFICIENT_DISK",
  "UNSAFE_ARCHIVE_PATH",
  "UNSAFE_ARCHIVE_LINK",
  "INVALID_ARCHIVE_SIZE",
  "BASELINE_CHANGED",
  "OPERATION_ID_CONFLICT",
  "OPERATION_BUSY",
  "UPLOAD_REQUIRED",
  "PENDING_OPERATION_RECONCILIATION",
  "INCIDENT_REQUIRES_MANUAL_RESOLUTION",
  "MAINTENANCE_ACTIVE",
  "WORKER_STATE_REQUIRES_RECONCILIATION",
  "WORKER_NEVER_STARTED",
  "WORKER_FAILED_BEFORE_OPERATION_RECEIPT",
  "QUEUED_CANDIDATE_CHANGED",
  "SCHEMA_MISMATCH",
  "WRONG_RUNNING_VERSION",
  "RUNTIME_MISMATCH",
  "MANIFEST_MISMATCH",
  "READ_ONLY_PAGE_FAILED",
  "SQLITE_INTEGRITY_FAILED",
  "STARTUP_FAILED",
  "STARTUP_TIMEOUT",
  "LOCAL_HEALTH_FAILED",
  "PUBLIC_VERSION_MISMATCH",
  "MAINTENANCE_BUDGET_EXCEEDED",
  "BASELINE_RECOVERY_FAILED",
  "POST_OPEN_VERIFICATION_FAILED",
  "ERROR_RESPONSE_INCREASE",
  "ACCESS_LOG_REQUIRED",
  "ACCESS_LOG_ROTATED",
  "INVALID_ACCESS_LOG",
]);
const terminal = (phase) =>
  ["completed", "succeeded", "failed"].includes(phase);
const optionalJson = async (path) => {
  try {
    return await json(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const match = (pattern, value) =>
  typeof value === "string" && pattern.test(value) ? value : undefined;
const number = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const timestamp = (value) =>
  match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, value);
function requireFact(ok, reason) {
  if (!ok) throw new Error(reason);
}
function code(error) {
  // Only known literal machine codes, never child stderr, assertion diffs or logs.
  const reason = String(error?.message ?? "").split(/[:\n]/, 1)[0];
  return PUBLIC_ERRORS.has(reason) ? reason : "REMOTE_OPERATION_REJECTED";
}
async function lockAlive(lock) {
  return (
    !!lock &&
    Number.isSafeInteger(lock.pid) &&
    lock.pid > 0 &&
    typeof lock.bootId === "string" &&
    typeof lock.startTime === "string" &&
    (await alive(lock))
  );
}
async function records(config, id) {
  const operation = await optionalJson(
    resolve(config.stateDir, "operations", `${id}.json`),
  );
  const request = await optionalJson(
    resolve(config.stateDir, "requests", `${id}.json`),
  );
  const result = await optionalJson(
    resolve(config.stateDir, "requests", `${id}.result.json`),
  );
  return { operation, request, result };
}
async function conditions(config) {
  const lock = await optionalJson(resolve(config.stateDir, "operation.lock"));
  let pending = false;
  for (const directory of ["operations", "requests"]) {
    const path = resolve(config.stateDir, directory);
    if (!(await exists(path))) continue;
    for (const name of await readdir(path)) {
      if (!name.endsWith(".json") || name.endsWith(".result.json")) continue;
      const id = name.slice(0, -5);
      requireFact(ID.test(id), "PENDING_OPERATION_RECONCILIATION");
      const saved = await records(config, id);
      if (!terminal((saved.operation ?? saved.result)?.phase)) pending = true;
    }
  }
  const busy = !!lock || pending;
  const frozen = await exists(resolve(config.stateDir, "incident.json"));
  const maintenance = await exists(config.maintenance);
  const reason = frozen
    ? "INCIDENT_REQUIRES_MANUAL_RESOLUTION"
    : lock && (await lockAlive(lock))
      ? "OPERATION_BUSY"
      : busy
        ? "PENDING_OPERATION_RECONCILIATION"
        : maintenance
          ? "MAINTENANCE_ACTIVE"
          : null;
  return { busy, frozen, maintenance, reason };
}
async function requireIdle(config) {
  const state = await conditions(config);
  requireFact(!state.reason, state.reason);
}
async function baseline(config) {
  const state = await conditions(config);
  if (state.reason) {
    const error = new Error(state.reason);
    error.summary = { mode: config.slots ? "slots" : "single", ...state };
    throw error;
  }
  const runtime = await json(resolve(config.stateDir, "runtime.json"));
  const manifest = await json(resolve(config.current, "release.json"));
  requireFact(SHA.test(runtime.commit ?? ""), "BASELINE_DISCREPANCY");
  requireFact(manifest.commit === runtime.commit, "BASELINE_DISCREPANCY");
  const response = await read(new URL("/health/ready", config.probeUrl), {
    headers: probeHeaders(config),
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  requireFact(response.status === 200, "READINESS_FAILED");
  const ready = await response.json();
  requireFact(ready.ready === true, "READINESS_FAILED");
  requireFact(ready.version === runtime.commit, "BASELINE_DISCREPANCY");
  return {
    mode: config.slots ? "slots" : "single",
    commit: runtime.commit,
    runningCommit: ready.version,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    ...state,
  };
}
function incoming(config, id) {
  requireFact(
    typeof config.incoming === "string" &&
      isAbsolute(config.incoming) &&
      resolve(config.incoming) === config.incoming &&
      config.incoming !== "/",
    "INCOMING_PATH_REQUIRED",
  );
  return resolve(config.incoming, id);
}
async function secureDirectory(path, create = false) {
  const parent = dirname(path);
  if (parent !== path) await secureDirectory(parent);
  if (create) await mkdir(path, { mode: 0o700 });
  const stat = await lstat(path);
  requireFact(
    stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o022) === 0,
    "UNSAFE_INCOMING",
  );
}
function validateReceipt(receipt) {
  try {
    assert.equal(receipt.schema, 1);
    assert.equal(receipt.mode, "manual");
    assert.match(receipt.commit, SHA);
    assert.match(receipt.baseline, SHA);
    assert.equal(receipt.node, process.version);
    assert.equal(receipt.platform, "linux");
    assert.equal(receipt.architecture, "x64");
    assert.equal(process.platform, "linux");
    assert.equal(process.arch, "x64");
    assert.match(receipt.sha256, DIGEST);
    assert.ok(
      Number.isSafeInteger(receipt.expectedSchema) &&
        receipt.expectedSchema >= 0,
    );
    assert.deepEqual(receipt.checks, [
      "architecture",
      "types",
      "build",
      "production-startup",
    ]);
    assert.ok(Array.isArray(receipt.migration.paths));
    assert.equal(typeof receipt.migration.confirmed, "boolean");
    assert.ok(
      receipt.migration.paths.every(
        (path) =>
          typeof path === "string" &&
          path.startsWith("server/infrastructure/sqlite/") &&
          !path.split("/").includes("..") &&
          !path.includes("\\"),
      ),
    );
    assert.ok(!receipt.migration.paths.length || receipt.migration.confirmed);
    assert.ok(
      typeof receipt.builtAt === "string" &&
        Number.isFinite(Date.parse(receipt.builtAt)),
    );
  } catch {
    throw new Error("INVALID_MANUAL_RECEIPT");
  }
}
function uploadedRecord(id, receipt) {
  return {
    id,
    phase: "uploaded",
    commit: match(SHA, receipt.commit),
    baseline: match(SHA, receipt.baseline),
    artifactSha256: match(DIGEST, receipt.sha256),
    bundleSha256: match(DIGEST, receipt.bundleSha256),
    expectedSchema: number(receipt.expectedSchema),
    builtAt: timestamp(receipt.builtAt),
    nextAction: "manual-release",
  };
}
function requestBaseline(request) {
  const args = request?.args;
  const index = Array.isArray(args) ? args.indexOf("--baseline") : -1;
  return index < 0 ? undefined : match(SHA, args[index + 1]);
}
function publicCriteria(value) {
  if (!value || typeof value !== "object") return undefined;
  const result = {};
  for (const key of [
    "processActive",
    "ready",
    "attachmentsAccessible",
    "readOnlyPage",
  ])
    if (typeof value[key] === "boolean") result[key] = value[key];
  result.version = match(SHA, value.version);
  result.schema = number(value.schema);
  result.integrity = ["ok", "failed"].includes(value.integrity)
    ? value.integrity
    : undefined;
  result.checkedAt = timestamp(value.checkedAt);
  if (value.errorResponses && typeof value.errorResponses === "object") {
    result.errorResponses = {
      errors: number(value.errorResponses.errors),
      requests: number(value.errorResponses.requests),
      from: timestamp(value.errorResponses.from),
      to: timestamp(value.errorResponses.to),
    };
  }
  return result;
}
async function status(config, id) {
  const saved = await records(config, id);
  // This immutable upload identity is installed atomically with the candidate,
  // but survives removal of the candidate files. Status never revalidates them.
  const upload = config.incoming
    ? await optionalJson(resolve(incoming(config, id), "upload.json"))
    : null;
  if (!saved.operation && !saved.request && !saved.result) {
    if (upload) return uploadedRecord(id, upload);
    if (config.incoming && (await exists(incoming(config, id))))
      return {
        id,
        phase: "unknown",
        reason: "WORKER_STATE_REQUIRES_RECONCILIATION",
        nextAction: "operator-reconciliation",
      };
    return { id, phase: "absent", nextAction: "manual-upload" };
  }
  const record = saved.operation ?? saved.result ?? saved.request;
  let phase = record.phase;
  if (!terminal(phase)) {
    const lock = await optionalJson(resolve(config.stateDir, "operation.lock"));
    if (saved.operation) {
      phase =
        lock?.id === id && (await lockAlive(lock)) ? record.phase : "unknown";
    } else {
      const active = command(
        "/bin/systemctl",
        "show",
        `daily-flow-operation-${id}.service`,
        "--property=ActiveState",
        "--value",
      ).trim();
      phase = ["active", "activating"].includes(active)
        ? "accepted"
        : "unknown";
    }
  }
  if (
    ![
      "accepted",
      "preparing",
      "stopping",
      "data-operation",
      "data-ready",
      "activating",
      "may-be-open",
      "rolling-back",
      "rollback-data-ready",
      "rollback-may-be-open",
      "completed",
      "succeeded",
      "failed",
      "unknown",
    ].includes(phase)
  )
    phase = "unknown";
  const operationPhase = phase;
  if (!["accepted", "unknown"].includes(phase) && !terminal(phase))
    phase = "running";
  if (phase === "succeeded") phase = "completed";
  const runtime = await optionalJson(resolve(config.stateDir, "runtime.json"));
  const recovery = [
    "not-needed",
    "baseline-restored",
    "restored-before-open",
    "original-service-restored",
    "preserved-new-data",
    "manual-intervention",
    "already-current",
  ].includes(record.recovery)
    ? record.recovery
    : undefined;
  return {
    id,
    phase,
    operationPhase,
    commit: match(
      SHA,
      record.target?.commit ?? record.commit ?? upload?.commit,
    ),
    baseline:
      match(SHA, record.baseline) ??
      requestBaseline(saved.request) ??
      match(SHA, upload?.baseline),
    actualCommit: match(SHA, record.actualCommit),
    runningCommit: match(SHA, runtime?.commit),
    artifactSha256: match(
      DIGEST,
      record.artifactSha256 ?? record.target?.sha256 ?? upload?.sha256,
    ),
    bundleSha256: match(DIGEST, upload?.bundleSha256 ?? record.bundleSha256),
    expectedSchema: number(
      record.expectedSchema ??
        record.target?.expectedSchema ??
        upload?.expectedSchema,
    ),
    criteria: publicCriteria(record.criteria),
    recovery,
    recoveryCriteria: publicCriteria(record.recoveryCriteria),
    failure: phase === "failed" ? code({ message: record.failure }) : undefined,
    recoveryFailure: record.recoveryFailure
      ? code({ message: record.recoveryFailure })
      : undefined,
    reason:
      phase === "unknown" ? "WORKER_STATE_REQUIRES_RECONCILIATION" : undefined,
    maintenanceMilliseconds: number(record.maintenanceMilliseconds),
    snapshotId: match(ID, record.snapshotId),
    createdAt: timestamp(record.createdAt),
    finishedAt: timestamp(record.finishedAt),
    maintenanceAt: timestamp(record.maintenanceAt),
    stoppedAt: timestamp(record.stoppedAt),
    mayHaveOpenedAt: timestamp(record.mayHaveOpenedAt),
    nextAction:
      phase === "unknown" ||
      recovery === "manual-intervention" ||
      recovery === "preserved-new-data"
        ? "operator-reconciliation"
        : phase === "failed"
          ? "new-release-id"
          : terminal(phase)
            ? "none"
            : "manual-status",
  };
}
async function upload(config, id, digest) {
  const target = incoming(config, id);
  await secureDirectory(config.incoming, !(await exists(config.incoming)));
  if (await exists(target)) {
    requireFact(
      (await readFile(resolve(target, "bundle.sha256"), "utf8")).trim() ===
        digest,
      "UPLOAD_ID_CONFLICT",
    );
    return status(config, id);
  }
  const saved = await records(config, id);
  requireFact(
    !saved.operation && !saved.request && !saved.result,
    "UPLOAD_ID_CONFLICT",
  );
  await requireIdle(config);
  await capacity(config, 1073741824, [config.incoming]);
  const stage = await mkdtemp(resolve(config.incoming, ".manual-upload-"));
  try {
    const archive = resolve(stage, "bundle.tar.gz");
    const file = await open(archive, "wx", 0o600);
    try {
      let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        requireFact(bytes <= 536870912, "UPLOAD_TOO_LARGE");
        await file.writeFile(chunk);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    requireFact((await sha256(archive)) === digest, "UPLOAD_DIGEST_MISMATCH");
    await capacity(config, archiveSize(archive) * 2, [stage]);
    const names = command("/usr/bin/tar", "-tzf", archive)
      .trim()
      .split("\n")
      .sort();
    requireFact(
      JSON.stringify(names) ===
        JSON.stringify(["application.tar.gz", "receipt.json"]),
      "INVALID_MANUAL_BUNDLE",
    );
    const content = resolve(stage, "content"),
      candidate = resolve(content, "candidate");
    await mkdir(content, { mode: 0o700 });
    await mkdir(candidate, { mode: 0o700 });
    extract(archive, candidate);
    for (const name of names) {
      const path = resolve(candidate, name);
      requireFact((await lstat(path)).isFile(), "INVALID_MANUAL_BUNDLE");
      await chmod(path, 0o600);
      await syncPath(path);
    }
    const receipt = await json(resolve(candidate, "receipt.json"));
    validateReceipt(receipt);
    requireFact(
      (await sha256(resolve(candidate, "application.tar.gz"))) ===
        receipt.sha256,
      "ARTIFACT_CHECKSUM",
    );
    await syncPath(candidate);
    await durable(resolve(content, "bundle.sha256"), digest);
    await durable(resolve(content, "upload.json"), {
      commit: receipt.commit,
      baseline: receipt.baseline,
      sha256: receipt.sha256,
      bundleSha256: digest,
      expectedSchema: receipt.expectedSchema,
      builtAt: receipt.builtAt,
    });
    // Uploading may take minutes; never install into a newly frozen/busy host.
    await requireIdle(config);
    try {
      await rename(content, target);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      requireFact(
        (await readFile(resolve(target, "bundle.sha256"), "utf8")).trim() ===
          digest,
        "UPLOAD_ID_CONFLICT",
      );
    }
    await syncPath(config.incoming);
    return status(config, id);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
async function release(config, id, baselineCommit, run) {
  const saved = await records(config, id);
  if (saved.operation || saved.request || saved.result) {
    const priorBaseline =
      saved.operation?.baseline ?? requestBaseline(saved.request);
    requireFact(
      priorBaseline === baselineCommit &&
        (!saved.operation || saved.operation.command === "manual-release") &&
        (!saved.request || saved.request.args?.[2] === "manual-release"),
      "OPERATION_ID_CONFLICT",
    );
    // Replays inspect immutable history, even after candidates were removed or
    // another release advanced runtime.json. Never call dispatch for this ID.
    return status(config, id);
  }
  await requireIdle(config);
  const target = incoming(config, id);
  requireFact(await exists(target), "UPLOAD_REQUIRED");
  await secureDirectory(resolve(target, "candidate"));
  const receipt = await json(resolve(target, "candidate", "receipt.json"));
  validateReceipt(receipt);
  requireFact(receipt.baseline === baselineCommit, "BASELINE_CHANGED");
  requireFact(
    (await baseline(config)).commit === baselineCommit,
    "BASELINE_CHANGED",
  );
  try {
    run(
      "./dispatch.mjs",
      "manual-release",
      "--id",
      id,
      "--candidate",
      resolve(target, "candidate"),
      "--baseline",
      baselineCommit,
    );
  } catch (error) {
    // Dispatch may already have persisted a failed request. Return its public
    // record rather than leaking a subprocess's stdout/stderr or retrying it.
    const after = await records(config, id);
    if (!after.operation && !after.request && !after.result) throw error;
  }
  return status(config, id);
}
export async function manualGateway(config, action, id, value, run) {
  try {
    requireFact(
      [
        "manual-baseline",
        "manual-status",
        "manual-upload",
        "manual-release",
      ].includes(action),
      "REMOTE_COMMAND_NOT_ALLOWED",
    );
    let result;
    if (action === "manual-baseline") {
      requireFact(
        id === undefined && value === undefined,
        "REMOTE_COMMAND_NOT_ALLOWED",
      );
      result = await baseline(config);
    } else {
      requireFact(ID.test(id ?? ""), "REMOTE_COMMAND_NOT_ALLOWED");
      if (action === "manual-status") {
        requireFact(value === undefined, "REMOTE_COMMAND_NOT_ALLOWED");
        result = await status(config, id);
      } else {
        requireFact(!config.slots, "MANUAL_SINGLE_INSTANCE_REQUIRED");
        requireFact(
          (action === "manual-upload" ? DIGEST : SHA).test(value ?? ""),
          "REMOTE_COMMAND_NOT_ALLOWED",
        );
        result =
          action === "manual-upload"
            ? await upload(config, id, value)
            : await release(config, id, value, run);
      }
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(
      JSON.stringify({
        ...error.summary,
        phase: "rejected",
        error: code(error),
      }),
    );
    process.exitCode = 1;
  }
}
