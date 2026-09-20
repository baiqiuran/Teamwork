// Root-operated import of an isolated host's report; never accepts business data.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { configuration } from "./host.mjs";
import { json, durable, sha256 } from "./io.mjs";
import { localOnly, localStatus } from "./local-backups.mjs";
const [flag, path, reportFlag, reportPath] = process.argv.slice(2);
assert.equal(flag, "--config");
assert.equal(reportFlag, "--report");
const config = await configuration(path, false),
  report = await json(reportPath);
assert.match(report.id, /^[a-zA-Z0-9_-]{1,80}$/);
if (report.phase === "failed") {
  const failedAt = Date.parse(report.failedAt);
  assert.ok(
    Number.isFinite(failedAt) &&
      failedAt >= (report.startedAt ? Date.parse(report.startedAt) : 0) &&
      failedAt <= Date.now(),
  );
  await durable(resolve(config.stateDir, "latest-drill.json"), {
    id: report.id,
    phase: "failed",
    failedAt: report.failedAt,
    failure: "RECOVERY_DRILL_FAILED",
    importedAt: new Date().toISOString(),
  });
  console.log(JSON.stringify({ id: report.id, phase: "failure-recorded" }));
  process.exit(0);
}
let job;
if (localOnly(config)) {
  await localStatus(config);
  const manifestPath = resolve(config.backupDir, report.id, "manifest.json");
  job = {
    ...(await json(manifestPath)),
    phase: "verified",
    manifestDigest: await sha256(manifestPath),
  };
} else
  job = await json(resolve(config.stateDir, "uploads", `${report.id}.json`));
assert.equal(job.phase, "verified");
assert.equal(report.phase, "verified");
assert.equal(report.manifestDigest, job.manifestDigest);
assert.equal(report.commit, job.commit);
assert.ok(report.attachmentsVerified && report.protocolsVerified);
for (const table of [
  "team",
  "members",
  "diaries",
  "projects",
  "tasks",
  "shares",
  "attachments",
  "sessions",
  "ai_grants",
  "ai_refresh",
  "ai_receipts",
])
  assert.equal(report.checks[table].verified, true);
const start = Date.parse(report.startedAt),
  end = Date.parse(report.finishedAt),
  snapshot = Date.parse(job.snapshotAt);
assert.ok(
  Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= snapshot &&
    end >= start &&
    end <= Date.now(),
);
const verified = {
  id: report.id,
  phase: "verified",
  commit: report.commit,
  manifestDigest: job.manifestDigest,
  startedAt: report.startedAt,
  finishedAt: report.finishedAt,
  snapshotAt: job.snapshotAt,
  recoveryMilliseconds: end - start,
  recoveryPointMilliseconds: start - snapshot,
  withinRto: end - start <= 14400000,
  withinRpo: start - snapshot <= 86400000,
  attachmentsVerified: true,
  protocolsVerified: true,
  checks: report.checks,
  importedAt: new Date().toISOString(),
};
await durable(resolve(config.stateDir, "latest-drill.json"), verified);
await durable(resolve(config.stateDir, "last-drill-success.json"), verified);
console.log(JSON.stringify({ id: report.id, phase: "recorded" }));
