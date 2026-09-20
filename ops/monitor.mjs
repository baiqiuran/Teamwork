// Trusted host diagnosis. Output contains operational metadata, never business rows.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { configuration, command, exists, capacity } from "./host.mjs";
import { json, durable } from "./io.mjs";
import { status as backupStatus } from "./offsite.mjs";
import { alive } from "./process-identity.mjs";

const [flag, path, action, id] = process.argv.slice(2);
assert.equal(flag, "--config");
assert.ok(["inspect", "complete"].includes(action));
assert.match(id ?? "", /^[a-zA-Z0-9_-]{1,72}$/);
let config = await configuration(path);
const directory = resolve(config.stateDir, "inspections");
await mkdir(directory, { recursive: true, mode: 0o700 });
const output = resolve(directory, `${id}.json`);
async function main() {
  if (action === "complete") {
    const report = await json(output);
    const runtime = await json(resolve(config.stateDir, "runtime.json"));
    assert.equal(report.phase, "healthy");
    assert.equal(report.actualCommit, runtime.commit);
    assert.ok(Date.now() - Date.parse(report.checkedAt) < 300000);
    assert.ok(!(await exists(resolve(config.stateDir, "operation.lock"))));
    assert.ok(!(await exists(resolve(config.stateDir, "incident.json"))));
    await durable(resolve(config.stateDir, "last-inspection-success.json"), {
      id,
      commit: runtime.commit,
      at: new Date().toISOString(),
    });
    return { phase: "completed", id, actualCommit: runtime.commit };
  }
  if (await exists(output)) return json(output);
  const issues = [];
  let publicService, busy;
  const lockPath = resolve(config.stateDir, "operation.lock");
  if (await exists(lockPath)) {
    const lock = await json(lockPath);
    busy = { id: lock.id, alive: await alive(lock) };
    if (!busy.alive) issues.push("UNKNOWN_OPERATION_REQUIRES_RECONCILIATION");
    const operationPath = resolve(
      config.stateDir,
      "operations",
      `${lock.id}.json`,
    );
    if (await exists(operationPath)) {
      const operation = await json(operationPath);
      busy.phase = operation.phase;
      busy.startedAt = operation.createdAt;
      if (Date.now() - Date.parse(operation.createdAt) > 600000)
        issues.push("OPERATION_BUDGET_EXCEEDED");
    }
  } else {
    let response;
    try {
      response = execFileSync(
        process.execPath,
        [
          ...process.execArgv,
          fileURLToPath(new URL("./control.mjs", import.meta.url)),
          "--config",
          resolve(path),
          "inspect",
          "--id",
          `monitor-${id}`,
        ],
        {
          encoding: "utf8",
          timeout: 120000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      response = String(error.stdout ?? "");
    }
    try {
      const operation = JSON.parse(response);
      if (operation.inspection) {
        publicService = {
          healthy: operation.inspection.healthy,
          maintenance: operation.inspection.maintenance === true,
        };
        if (!publicService.healthy) issues.push("SERVICE_UNAVAILABLE");
      } else issues.push("UNKNOWN_OPERATION_REQUIRES_RECONCILIATION");
    } catch {
      issues.push("UNKNOWN_OPERATION_REQUIRES_RECONCILIATION");
    }
  }
  config = await configuration(path);
  const runtime = await json(resolve(config.stateDir, "runtime.json"));
  const backup = config.oss
    ? await backupStatus(config)
    : { backup: "not-configured", fresh: false, pending: 0, failures: [] };
  if (!backup.fresh) issues.push("OFFSITE_BACKUP_STALE");
  if (backup.failures.length) issues.push("OFFSITE_UPLOAD_FAILED");
  try {
    await capacity(config, 0);
  } catch {
    issues.push("INSUFFICIENT_DISK");
  }
  let certificate;
  try {
    assert.ok(config.certificateFile?.startsWith("/"));
    const value = command(
      "/usr/bin/openssl",
      "x509",
      "-in",
      config.certificateFile,
      "-noout",
      "-enddate",
    )
      .trim()
      .replace(/^notAfter=/, "");
    const expiration = Date.parse(value);
    assert.ok(Number.isFinite(expiration));
    certificate = { expiresAt: new Date(expiration).toISOString() };
    if (expiration - Date.now() < 21600000) issues.push("CERTIFICATE_EXPIRING");
  } catch {
    issues.push("CERTIFICATE_EVIDENCE_MISSING");
  }
  const timers = [];
  for (const unit of new Set([
    ...(config.monitorTimers ?? [
      "daily-flow-backup.timer",
      "daily-flow-upload.timer",
      "daily-flow-retention.timer",
    ]),
    config.renewalTimer,
  ])) {
    try {
      assert.match(unit ?? "", /^[a-zA-Z0-9@._-]+\.timer$/);
      const state = command(
        "/bin/systemctl",
        "show",
        unit,
        "--property=ActiveState",
        "--property=SubState",
      );
      assert.ok(
        state.includes("ActiveState=active") &&
          /SubState=(waiting|running)/.test(state),
      );
      timers.push({ unit, active: true });
      const service = command(
        "/bin/systemctl",
        "show",
        unit,
        "--property=Unit",
        "--value",
      ).trim();
      assert.match(service, /^[a-zA-Z0-9@._-]+\.service$/);
      const result = command(
        "/bin/systemctl",
        "show",
        service,
        "--property=Result",
        "--value",
      ).trim();
      if (result && result !== "success") issues.push("TIMER_JOB_FAILED");
    } catch {
      timers.push({ unit: unit ?? "certificate-renewal", active: false });
      issues.push("TIMER_INACTIVE");
    }
  }
  const drillPath = resolve(config.stateDir, "latest-drill.json");
  let drill;
  if (await exists(drillPath)) {
    const record = await json(drillPath);
    drill = {
      phase: record.phase,
      finishedAt: record.finishedAt,
      withinRto: record.withinRto,
      withinRpo: record.withinRpo,
    };
    if (record.phase !== "verified") issues.push("RECOVERY_DRILL_FAILED");
    if (
      !Number.isFinite(Date.parse(record.finishedAt)) ||
      Date.parse(record.finishedAt) > Date.now() ||
      Date.now() - Date.parse(record.finishedAt) > 31 * 86400000
    )
      issues.push("RECOVERY_DRILL_OVERDUE");
    if (record.withinRto !== true || record.withinRpo !== true)
      issues.push("RECOVERY_GOAL_MISSED");
  } else issues.push("RECOVERY_DRILL_MISSING");
  const incident = await exists(resolve(config.stateDir, "incident.json"));
  if (incident) issues.push("INCIDENT_REQUIRES_MANUAL_RESOLUTION");
  const lastPath = resolve(config.stateDir, "last-inspection-success.json");
  const lastSuccess = (await exists(lastPath))
    ? (await json(lastPath)).at
    : null;
  const drillSuccessPath = resolve(config.stateDir, "last-drill-success.json");
  const lastDrillSuccess = (await exists(drillSuccessPath))
    ? (await json(drillSuccessPath)).finishedAt
    : drill?.phase === "verified"
      ? drill.finishedAt
      : null;
  const report = {
    id,
    phase: issues.length ? "failed" : busy ? "busy" : "healthy",
    checkedAt: new Date().toISOString(),
    actualCommit: runtime.commit,
    slot: runtime.slot,
    publicService,
    busy,
    backup,
    certificate,
    timers,
    drill,
    lastSuccess,
    lastDrillSuccess,
    issues: [...new Set(issues)],
  };
  await durable(output, report);
  await durable(resolve(config.stateDir, "latest-inspection.json"), report);
  return report;
}
try {
  const result = await main();
  console.log(JSON.stringify(result));
  if (result.phase === "failed") process.exitCode = 1;
} catch {
  console.log(
    JSON.stringify({
      id,
      phase: "failed",
      issues: ["INSPECTION_EVIDENCE_UNAVAILABLE"],
    }),
  );
  process.exitCode = 1;
}
