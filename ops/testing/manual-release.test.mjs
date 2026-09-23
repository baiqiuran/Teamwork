import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { manualFixture } from "./manual-fixture.mjs";
import { run } from "./fixture.mjs";
import { spawnSync } from "node:child_process";
import { json, sha256 } from "../io.mjs";

test("a failed manual release preserves its receipt and refuses replay or a new release until explicit resolution", async (t) => {
  const f = await manualFixture(t);
  const candidate = await f.candidate("broken");
  const receipt = await json(`${candidate}/receipt.json`);
  await writeFile(
    `${candidate}/receipt.json`,
    JSON.stringify({ ...receipt, sha256: "0".repeat(64) }),
  );
  const args = [
    "manual-release",
    "--id",
    "broken",
    "--candidate",
    candidate,
    "--baseline",
    f.baseline,
  ];
  const failed = await f.control(...args);
  assert.equal(failed.code, 1, failed.output + failed.error);
  const recordPath = `${f.config.stateDir}/operations/broken.json`;
  const before = await readFile(recordPath, "utf8");
  assert.match(before, /ARTIFACT_CHECKSUM/);
  assert.equal((await json(recordPath)).phase, "failed");
  const repeat = await f.control(...args);
  assert.equal(repeat.code, 1, repeat.output + repeat.error);
  assert.equal(await readFile(recordPath, "utf8"), before);
  assert.deepEqual(await readdir(f.config.backupDir), []);
  const next = await f.control(
    "manual-release",
    "--id",
    "another",
    "--candidate",
    candidate,
    "--baseline",
    f.baseline,
  );
  assert.equal(next.code, 1);
  assert.match(next.output + next.error, /MAINTENANCE_OR_INCIDENT_ACTIVE/);
  assert.equal(
    (await fetch(`${f.origin}/health/ready`).then((r) => r.json())).version,
    f.baseline,
  );
  const resolved = await f.control(
    "resolve-incident",
    "--id",
    "resolve",
    "--incident",
    "broken",
    "--expected-commit",
    f.baseline,
    "--note",
    "Verified existing version and preserved data",
  );
  assert.equal(resolved.code, 0, resolved.output + resolved.error);
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
});

test("manual release publishes one instance with a paired snapshot and durable criteria without migration-note proofs", async (t) => {
  const f = await manualFixture(t);
  const candidate = await f.candidate("good");
  const result = await f.control(
    "manual-release",
    "--id",
    "good",
    "--candidate",
    candidate,
    "--baseline",
    f.baseline,
  );
  assert.equal(result.code, 0, result.output + result.error);
  const record = await json(`${f.config.stateDir}/operations/good.json`);
  assert.equal(record.phase, "completed");
  assert.equal(record.actualCommit, "b".repeat(40));
  assert.equal(
    record.artifactSha256,
    await sha256(`${candidate}/application.tar.gz`),
  );
  assert.equal(record.criteria.schema, f.expectedSchema);
  assert.equal(record.criteria.integrity, "ok");
  assert.equal(record.criteria.readOnlyPage, true);
  assert.ok(
    record.maintenanceMilliseconds > 0 &&
      record.maintenanceMilliseconds <= 180000,
  );
  assert.equal(
    record.maintenanceMilliseconds,
    Date.parse(record.maintenanceEndedAt) - Date.parse(record.maintenanceAt),
  );
  assert.ok(
    Date.parse(record.finishedAt) >= Date.parse(record.maintenanceEndedAt),
  );
  assert.equal(
    (await fetch(`${f.origin}/health/ready`).then((r) => r.json())).version,
    "b".repeat(40),
  );
  assert.equal(
    (await json(`${f.config.backupDir}/good/manifest.json`)).commit,
    f.baseline,
  );
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
  const backup = await f.control("backup", "--id", "after-release");
  assert.equal(backup.code, 0, backup.output + backup.error);
});

test("a candidate that cannot start on existing data restores paired baseline once and records a failed release", async (t) => {
  const f = await manualFixture(t);
  const candidate = await f.candidate("will-not-start", async (runtime) => {
    const main = `${runtime}/build/server/main.js`;
    await writeFile(
      main,
      `if (process.env.DAILY_DATABASE_PATH.includes('/data/')) process.exit(42);\n${await readFile(main, "utf8")}`,
    );
  });
  const args = [
    "manual-release",
    "--id",
    "rollback",
    "--candidate",
    candidate,
    "--baseline",
    f.baseline,
  ];
  const failed = await f.control(...args);
  assert.equal(failed.code, 1, failed.output + failed.error);
  const path = `${f.config.stateDir}/operations/rollback.json`;
  const record = await json(path);
  assert.equal(record.recovery, "baseline-restored", JSON.stringify(record));
  assert.equal(record.actualCommit, f.baseline);
  assert.equal(record.recoveryCriteria.schema, f.expectedSchema);
  assert.equal(
    (await fetch(`${f.origin}/health/ready`).then((r) => r.json())).version,
    f.baseline,
  );
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
  const snapshotHash = await sha256(
    `${f.config.backupDir}/rollback/manifest.json`,
  );
  const before = await readFile(path, "utf8");
  const replay = await f.control(...args);
  assert.equal(replay.code, 1);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(
    await sha256(`${f.config.backupDir}/rollback/manifest.json`),
    snapshotHash,
  );
  assert.ok(
    (await readdir(f.root)).some((name) =>
      name.startsWith("data.before-restore-"),
    ),
  );
});

test("a killed manual worker is recovered explicitly without replaying the candidate or overwriting its snapshot", async (t) => {
  const f = await manualFixture(t);
  const candidate = await f.candidate("interrupted");
  const hook = `${f.root}/interrupt.mjs`;
  await writeFile(
    hook,
    `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; const rename=fs.rename; fs.rename=async function(from,to){const result=await rename(from,to); if(to===${JSON.stringify(f.config.current)}) process.kill(process.pid,'SIGKILL'); return result;}; syncBuiltinESMExports();`,
  );
  const args = [
    "manual-release",
    "--id",
    "interrupted",
    "--candidate",
    candidate,
    "--baseline",
    f.baseline,
  ];
  const killed = await f.controlWith(["--import", hook], ...args);
  assert.notEqual(killed.code, 0);
  assert.equal((await fetch(`${f.origin}/login`)).status, 503);
  const snapshotHash = await sha256(
    `${f.config.backupDir}/interrupted/manifest.json`,
  );
  const blocked = await f.control("backup", "--id", "cannot-bypass");
  assert.equal(blocked.code, 1);
  assert.match(blocked.output + blocked.error, /OPERATION_BUSY/);
  await rm(`${f.config.stateDir}/operation.lock`);
  const bypass = await f.control("backup", "--id", "deleted-lock");
  assert.equal(bypass.code, 1);
  assert.match(
    bypass.output + bypass.error,
    /PENDING_OPERATION_RECONCILIATION/,
  );
  const reconciled = spawnSync(
    process.execPath,
    ["/repository/ops/reconcile.mjs", "--config", `${f.root}/deploy.json`],
    { encoding: "utf8" },
  );
  assert.equal(reconciled.status, 0, reconciled.stdout + reconciled.stderr);
  assert.equal(JSON.parse(reconciled.stdout).recovery, "baseline-restored");
  assert.equal(
    await sha256(`${f.config.backupDir}/interrupted/manifest.json`),
    snapshotHash,
  );
  assert.equal(
    (await fetch(`${f.origin}/health/ready`).then((r) => r.json())).version,
    f.baseline,
  );
  const record = await readFile(
    `${f.config.stateDir}/operations/interrupted.json`,
    "utf8",
  );
  const replay = await f.control(...args);
  assert.equal(replay.code, 1);
  assert.equal(
    await readFile(`${f.config.stateDir}/operations/interrupted.json`, "utf8"),
    record,
  );
});

test("failed paired recovery stays in maintenance and never loops or overwrites evidence", async (t) => {
  const f = await manualFixture(t);
  const candidate = await f.candidate("recovery-fails");
  const hook = `${f.root}/fault.mjs`;
  await writeFile(
    hook,
    `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module'; const original=cp.execFileSync; cp.execFileSync=function(name,args,...rest){if(name==='/bin/systemctl' && args[0]==='start') throw new Error('INJECTED_START_FAILURE'); if(name==='/usr/bin/flock' && args.includes('rollback')) throw new Error('INJECTED_RECOVERY_FAILURE');return original.call(this,name,args,...rest);};syncBuiltinESMExports();`,
  );
  const args = [
    "manual-release",
    "--id",
    "failed-recovery",
    "--candidate",
    candidate,
    "--baseline",
    f.baseline,
  ];
  const result = await f.controlWith(["--import", hook], ...args);
  assert.equal(result.code, 1, result.output + result.error);
  const path = `${f.config.stateDir}/operations/failed-recovery.json`;
  const record = await json(path);
  assert.equal(record.recovery, "manual-intervention");
  assert.match(record.recoveryFailure, /INJECTED_RECOVERY_FAILURE/);
  assert.match(record.nextAction, /resolve-incident/);
  const response = await fetch(`${f.origin}/login`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "60");
  const hash = await sha256(
    `${f.config.backupDir}/failed-recovery/manifest.json`,
  );
  const replay = await f.control(...args);
  assert.equal(replay.code, 1);
  assert.deepEqual(await json(path), record);
  assert.equal(
    await sha256(`${f.config.backupDir}/failed-recovery/manifest.json`),
    hash,
  );
});

test("a lost acknowledgement of the durable opening marker preserves new data and prohibits automatic restore", async (t) => {
  const f = await manualFixture(t);
  const candidate = await f.candidate("opening");
  const path = `${f.config.stateDir}/operations/opening.json`;
  const hook = `${f.root}/open-fault.mjs`;
  await writeFile(
    hook,
    `import fs from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';const rename=fs.rename;let failed=false;fs.rename=async function(from,to){const result=await rename(from,to);if(!failed && to===${JSON.stringify(path)} && JSON.parse(await fs.readFile(to,'utf8')).phase==='may-be-open'){failed=true;throw new Error('OPEN_ACK_LOST');}return result;};syncBuiltinESMExports();`,
  );
  const result = await f.controlWith(
    ["--import", hook],
    "manual-release",
    "--id",
    "opening",
    "--candidate",
    candidate,
    "--baseline",
    f.baseline,
  );
  assert.equal(result.code, 1, result.output + result.error);
  const record = await json(path);
  assert.equal(record.recovery, "preserved-new-data", JSON.stringify(record));
  assert.ok(record.mayHaveOpenedAt);
  assert.equal(
    (await json(`${f.config.stateDir}/runtime.json`)).commit,
    "b".repeat(40),
  );
  assert.equal((await fetch(`${f.origin}/login`)).status, 503);
  assert.ok(
    !(await readdir(f.root)).some((name) =>
      name.startsWith("data.before-restore-"),
    ),
  );
});

test("a post-opening log failure keeps the recorded maintenance interval consistent", async (t) => {
  const f = await manualFixture(t);
  const candidate = await f.candidate("post-open-log");
  const hook = `${f.root}/post-open-log-fault.mjs`;
  await writeFile(
    hook,
    `import fs from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';const rm=fs.rm,open=fs.open;let opened=false;fs.rm=async function(path,...args){const result=await rm(path,...args);if(path===${JSON.stringify(f.config.maintenance)})opened=true;return result;};fs.open=async function(path,...args){if(opened&&path===${JSON.stringify(f.config.manualAccessLog)})throw new Error('INJECTED_POST_OPEN_LOG_FAILURE');return open(path,...args);};syncBuiltinESMExports();`,
  );
  const result = await f.controlWith(
    ["--import", hook],
    "manual-release",
    "--id",
    "post-open-log",
    "--candidate",
    candidate,
    "--baseline",
    f.baseline,
  );
  assert.equal(result.code, 1, result.output + result.error);
  const record = await json(
    `${f.config.stateDir}/operations/post-open-log.json`,
  );
  assert.match(record.failure, /INJECTED_POST_OPEN_LOG_FAILURE/);
  assert.equal(record.recovery, "preserved-new-data");
  assert.equal(
    record.maintenanceMilliseconds,
    Date.parse(record.maintenanceEndedAt) - Date.parse(record.maintenanceAt),
  );
  assert.equal((await fetch(`${f.origin}/login`)).status, 503);
});

test("a budget miss discovered after reopening records an incident without closing a healthy site", async (t) => {
  const f = await manualFixture(t);
  const candidate = await f.candidate("late-opening");
  const hook = `${f.root}/late-opening-clock.mjs`;
  await writeFile(
    hook,
    `import fs from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';const rm=fs.rm,RealDate=Date;fs.rm=async function(path,...args){const result=await rm(path,...args);if(path===${JSON.stringify(f.config.maintenance)})globalThis.Date=class extends RealDate{constructor(...values){super(...(values.length?values:[RealDate.now()+180001]));}static now(){return RealDate.now()+180001;}};return result;};syncBuiltinESMExports();`,
  );
  const result = await f.controlWith(
    ["--import", hook],
    "manual-release",
    "--id",
    "late-opening",
    "--candidate",
    candidate,
    "--baseline",
    f.baseline,
  );
  assert.equal(result.code, 1, result.output + result.error);
  const record = await json(
    `${f.config.stateDir}/operations/late-opening.json`,
  );
  assert.equal(record.failure, "MAINTENANCE_BUDGET_EXCEEDED");
  assert.equal(record.recovery, "preserved-new-data");
  assert.ok(record.maintenanceMilliseconds > 180000);
  assert.equal(
    record.maintenanceMilliseconds,
    Date.parse(record.maintenanceEndedAt) - Date.parse(record.maintenanceAt),
  );
  assert.equal((await fetch(`${f.origin}/login`)).status, 200);
  assert.equal(
    (await json(`${f.config.stateDir}/incident.json`)).id,
    "late-opening",
  );
});

test("an actual proxy 5xx during acceptance prevents opening and restores the paired baseline", async (t) => {
  const f = await manualFixture(t);
  const candidate = await f.candidate("proxy-error");
  const hook = `${f.root}/proxy-error.mjs`;
  await writeFile(
    hook,
    `import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';const original=cp.execFileSync;let sent=false;cp.execFileSync=function(name,args,...rest){const result=original.call(this,name,args,...rest);if(!sent&&name==='/bin/systemctl'&&args[0]==='start'){sent=true;original('/usr/bin/curl',['--silent',${JSON.stringify(f.origin + "/fixture-error")}]);}return result;};syncBuiltinESMExports();`,
  );
  const result = await f.controlWith(
    ["--import", hook],
    "manual-release",
    "--id",
    "proxy-error",
    "--candidate",
    candidate,
    "--baseline",
    f.baseline,
  );
  assert.equal(result.code, 1, result.output + result.error);
  const record = await json(`${f.config.stateDir}/operations/proxy-error.json`);
  assert.match(record.failure, /ERROR_RESPONSE_INCREASE/);
  assert.equal(record.recovery, "baseline-restored");
  assert.equal(
    (await fetch(`${f.origin}/health/ready`).then((r) => r.json())).version,
    f.baseline,
  );
});

test("a manual request whose dispatch acknowledgement was lost cannot launch a new worker on replay", async (t) => {
  const f = await manualFixture(t);
  const candidate = await f.candidate("dispatch-lost");
  const hook = `${f.root}/dispatch-fault.mjs`;
  await writeFile(
    hook,
    `import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';const original=cp.execFileSync;cp.execFileSync=function(name,args,...rest){if(name==='/usr/bin/systemd-run')throw new Error('DISPATCH_ACK_LOST');return original.call(this,name,args,...rest);};syncBuiltinESMExports();`,
  );
  const args = [
    "/repository/ops/dispatch.mjs",
    "--config",
    `${f.root}/deploy.json`,
    "manual-release",
    "--id",
    "dispatch-lost",
    "--candidate",
    candidate,
    "--baseline",
    f.baseline,
  ];
  const failed = spawnSync(process.execPath, ["--import", hook, ...args], {
    encoding: "utf8",
    env: { ...process.env, DAILY_DISPATCH_LOCKED: "1" },
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /DISPATCH_ACK_LOST/);
  const requestPath = `${f.config.stateDir}/requests/dispatch-lost.json`;
  const before = await readFile(requestPath, "utf8");
  const replay = spawnSync(process.execPath, ["--import", hook, ...args], {
    encoding: "utf8",
    env: { ...process.env, DAILY_DISPATCH_LOCKED: "1" },
  });
  assert.equal(
    JSON.parse(replay.stdout).phase,
    "unknown",
    replay.stdout + replay.stderr,
  );
  assert.equal(await readFile(requestPath, "utf8"), before);
  assert.equal(
    run(
      "systemctl",
      "show",
      "daily-flow-operation-dispatch-lost.service",
      "--property=LoadState",
      "--value",
    ).trim(),
    "not-found",
  );
});

test("reconciling a dead manual request leaves an explicit incident instead of blocking the host forever", async (t) => {
  const f = await manualFixture(t);
  const candidate = await f.candidate("never-started");
  const hook = `${f.root}/never-started-fault.mjs`;
  await writeFile(
    hook,
    `import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';const original=cp.execFileSync;cp.execFileSync=function(name,args,...rest){if(name==='/usr/bin/systemd-run')throw new Error('DISPATCH_ACK_LOST');return original.call(this,name,args,...rest);};syncBuiltinESMExports();`,
  );
  const args = [
    "/repository/ops/dispatch.mjs",
    "--config",
    `${f.root}/deploy.json`,
    "manual-release",
    "--id",
    "never-started",
    "--candidate",
    candidate,
    "--baseline",
    f.baseline,
  ];
  const submitted = spawnSync(process.execPath, ["--import", hook, ...args], {
    encoding: "utf8",
    env: { ...process.env, DAILY_DISPATCH_LOCKED: "1" },
  });
  assert.equal(submitted.status, 1, submitted.stdout + submitted.stderr);
  const requests = `${f.config.stateDir}/requests`;
  assert.ok((await readdir(requests)).includes("never-started.json"));

  const reconciled = spawnSync(
    process.execPath,
    ["/repository/ops/reconcile.mjs", "--config", `${f.root}/deploy.json`],
    { encoding: "utf8" },
  );
  assert.equal(reconciled.status, 0, reconciled.stdout + reconciled.stderr);
  const result = await json(`${requests}/never-started.result.json`);
  assert.equal(result.phase, "failed");
  assert.match(result.failure, /WORKER_NEVER_STARTED/);
  assert.equal(
    (await json(`${f.config.stateDir}/incident.json`)).id,
    "never-started",
  );
  assert.deepEqual(
    (await readdir(`${f.config.stateDir}/operations`)).filter((name) =>
      name.startsWith("never-started"),
    ),
    [],
  );
  assert.equal(
    run(
      "systemctl",
      "show",
      "daily-flow-operation-never-started.service",
      "--property=LoadState",
      "--value",
    ).trim(),
    "not-found",
  );
  assert.equal(
    (await json(`${f.config.stateDir}/runtime.json`)).commit,
    f.baseline,
  );

  const resolved = await f.control(
    "resolve-incident",
    "--id",
    "resolve-stuck",
    "--incident",
    "never-started",
    "--expected-commit",
    f.baseline,
    "--note",
    "Verified baseline after a dispatch request never started",
  );
  assert.equal(resolved.code, 0, resolved.output + resolved.error);
  assert.equal(
    (await fetch(`${f.origin}/health/ready`).then((r) => r.json())).version,
    f.baseline,
  );
});
