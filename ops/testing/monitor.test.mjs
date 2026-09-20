import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { slotsFixture } from "./slots-fixture.mjs";
import { run } from "./fixture.mjs";
import { sshFixture } from "./ssh-fixture.mjs";

test("inspection distinguishes live service, stale backups, failed transfers and overdue recovery without changing data", async (t) => {
  const f = await slotsFixture(t);
  const baseline = JSON.parse(
    await readFile(f.root + "/current/release.json", "utf8"),
  ).commit;
  const release = await f.control(
    "release",
    "--id",
    "monitor-release",
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    baseline,
  );
  assert.equal(release.code, 0, release.output + release.error);
  run(
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    f.root + "/cert.key",
    "-out",
    f.root + "/cert.pem",
    "-subj",
    "/CN=localhost",
    "-days",
    "2",
  );
  f.config.certificateFile = f.root + "/cert.pem";
  f.config.renewalTimer = f.id + "-certificate.timer";
  f.config.monitorTimers = [f.config.renewalTimer];
  await writeFile(
    `/etc/systemd/system/${f.id}-certificate.service`,
    "[Service]\nType=oneshot\nExecStart=/bin/true\n",
  );
  await writeFile(
    `/etc/systemd/system/${f.config.renewalTimer}`,
    `[Timer]\nOnActiveSec=12h\nUnit=${f.id}-certificate.service\n`,
  );
  run("systemctl", "daemon-reload");
  run("systemctl", "start", f.config.renewalTimer);
  t.after(() => run("systemctl", "stop", f.config.renewalTimer));
  await writeFile(f.root + "/deploy.json", JSON.stringify(f.config));
  const drill = {
    phase: "verified",
    finishedAt: new Date().toISOString(),
    withinRto: true,
    withinRpo: true,
  };
  await writeFile(f.root + "/control/latest-drill.json", JSON.stringify(drill));
  const inspect = async (id, hook, action = "inspect") => {
    const child = spawn(
      process.execPath,
      [
        ...(hook ? ["--import", hook] : []),
        "ops/monitor.mjs",
        "--config",
        f.root + "/deploy.json",
        action,
        id,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      error = "";
    child.stdout.on("data", (v) => (output += v));
    child.stderr.on("data", (v) => (error += v));
    const [code] = await once(child, "exit");
    assert.ok(output.trim(), error);
    return { code, report: JSON.parse(output) };
  };
  let result = await inspect("healthy");
  assert.equal(result.code, 0, JSON.stringify(result.report));
  assert.equal(result.report.phase, "healthy");
  assert.equal(result.report.backup.pending, 1);
  assert.equal(result.report.publicService.healthy, true);
  assert.equal(JSON.stringify(result.report).includes("恢复前的内容"), false);
  const ssh = await sshFixture(t, f);
  const remote = await ssh("inspect remote-healthy");
  assert.equal(remote.code, 0, remote.output + remote.error);
  assert.equal(JSON.parse(remote.output).phase, "healthy");
  assert.equal((await ssh("inspection-complete remote-healthy")).code, 0);
  assert.equal((await inspect("healthy", undefined, "complete")).code, 0);
  const successful = await readFile(
    f.root + "/control/last-inspection-success.json",
    "utf8",
  );
  const raceHook = f.root + "/lock-race.mjs";
  await writeFile(
    raceHook,
    `import cp from 'node:child_process'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original=cp.execFileSync; cp.execFileSync=function(command,args,...rest) {
 if(args.some(x=>String(x).endsWith('/control.mjs'))) {
 const stat=fs.readFileSync('/proc/'+process.pid+'/stat','utf8');
 fs.writeFileSync(${JSON.stringify(f.root + "/control/operation.lock")},JSON.stringify({id:'concurrent-release',pid:process.pid,bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),startTime:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}));
 return JSON.stringify({phase:'failed',failure:'OPERATION_BUSY'}); }
 return original.call(this,command,args,...rest); };syncBuiltinESMExports();`,
  );
  const raced = await inspect("racing", raceHook);
  assert.equal(raced.report.phase, "busy");
  assert.ok(
    !raced.report.issues.includes("UNKNOWN_OPERATION_REQUIRES_RECONCILIATION"),
  );
  await rm(f.root + "/control/operation.lock");
  const priorPath = f.root + "/control/uploads/prior.json";
  const prior = JSON.parse(await readFile(priorPath, "utf8"));
  await writeFile(
    priorPath,
    JSON.stringify({
      ...prior,
      snapshotAt: new Date(Date.now() - 86401000).toISOString(),
    }),
  );
  const uploadPath = f.root + "/control/uploads/monitor-release.json";
  const upload = JSON.parse(await readFile(uploadPath, "utf8"));
  await writeFile(
    uploadPath,
    JSON.stringify({
      ...upload,
      phase: "failed",
      failure: "REMOTE_UNAVAILABLE",
    }),
  );
  await writeFile(
    f.root + "/control/latest-drill.json",
    JSON.stringify({
      ...drill,
      finishedAt: new Date(Date.now() - 32 * 86400000).toISOString(),
    }),
  );
  result = await inspect("backup-failed");
  assert.equal(result.code, 1);
  assert.ok(result.report.issues.includes("OFFSITE_BACKUP_STALE"));
  assert.ok(result.report.issues.includes("OFFSITE_UPLOAD_FAILED"));
  assert.ok(result.report.issues.includes("RECOVERY_DRILL_OVERDUE"));
  assert.equal(result.report.publicService.healthy, true);
  assert.equal((await inspect("backup-failed", undefined, "complete")).code, 1);
  assert.equal(
    await readFile(f.root + "/control/last-inspection-success.json", "utf8"),
    successful,
  );
  assert.equal((await fetch(f.origin + "/login")).status, 200);
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
  // External HTTPS failures are independent of healthy host protocol checks.
  await inspect("external-one");
  result = await inspect("external-one", undefined, "external-failure");
  assert.equal(result.report.failures, 1);
  assert.equal(result.report.maintenance, false);
  assert.equal(
    (await inspect("external-one", undefined, "external-failure")).report
      .failures,
    1,
  );
  assert.equal((await fetch(f.origin + "/login")).status, 200);
  const hook = f.root + "/later.mjs";
  await writeFile(hook, "const now=Date.now; Date.now=()=>now()+61000;");
  await inspect("external-two", hook);
  result = await inspect("external-two", hook, "external-failure");
  assert.equal(result.report.maintenance, false);
  await inspect("external-three", hook);
  result = await inspect("external-three", hook, "external-failure");
  assert.equal(result.report.maintenance, true);
  assert.equal((await fetch(f.origin + "/login")).status, 503);
});
