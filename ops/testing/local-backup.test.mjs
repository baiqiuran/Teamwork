import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, readdir, cp, rm, rename } from "node:fs/promises";
import { slotsFixture } from "./slots-fixture.mjs";
import { run } from "./fixture.mjs";
import { sha256 } from "../io.mjs";

const cli = (f, action, ...args) =>
  JSON.parse(
    run(
      "node",
      "/repository/ops/backup-cli.mjs",
      "--config",
      f.root + "/deploy.json",
      action,
      ...args,
    ),
  );
async function localFixture(t) {
  const f = await slotsFixture(t);
  f.config.backupMode = "local";
  delete f.config.oss;
  await writeFile(f.root + "/deploy.json", JSON.stringify(f.config));
  await rm(f.root + "/control/uploads", { recursive: true });
  return f;
}
test("local-only backup gates release, preserves data and creates no cloud jobs", async (t) => {
  const f = await localFixture(t);
  const baseline = JSON.parse(
    await readFile(f.root + "/current/release.json"),
  ).commit;
  let result = await f.control(
    "release",
    "--id",
    "no-backup",
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    baseline,
  );
  assert.notEqual(result.code, 0);
  assert.match(result.output, /LOCAL_BACKUP_EXPIRED_OR_MISSING/);
  result = await f.control("backup", "--id", "daily-local", "--kind", "daily");
  assert.equal(result.code, 0, result.output + result.error);
  assert.equal(cli(f, "status").mode, "local");
  const manifestPath = `${f.config.backupDir}/daily-local/manifest.json`;
  const originalManifest = await readFile(manifestPath);
  await writeFile(
    manifestPath,
    JSON.stringify({
      ...JSON.parse(originalManifest),
      snapshotAt: new Date(Date.now() - 86400001).toISOString(),
    }),
  );
  await writeFile(
    `${f.config.backupDir}/daily-local/manifest.sha256`,
    await sha256(manifestPath),
  );
  result = await f.control(
    "release",
    "--id",
    "stale-local",
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    baseline,
  );
  assert.notEqual(result.code, 0);
  assert.match(result.output, /LOCAL_BACKUP_EXPIRED_OR_MISSING/);
  await writeFile(manifestPath, originalManifest);
  await writeFile(
    `${f.config.backupDir}/daily-local/manifest.sha256`,
    await sha256(manifestPath),
  );
  result = await f.control(
    "release",
    "--id",
    "local-release",
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    baseline,
  );
  assert.equal(result.code, 0, result.output + result.error);
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
  assert.ok(!(await readdir(f.config.stateDir)).includes("uploads"));
  let inspection;
  try {
    inspection = run(
      "node",
      "/repository/ops/monitor.mjs",
      "--config",
      f.root + "/deploy.json",
      "inspect",
      "local-monitor",
    );
  } catch (error) {
    inspection = error.stdout;
  } // Certificate/timer/drill setup is intentionally absent here.
  const monitored = JSON.parse(inspection);
  assert.equal(monitored.backup.mode, "local");
  assert.equal(monitored.backup.fresh, true);
  assert.ok(monitored.issues.every((issue) => !issue.startsWith("OFFSITE")));
  assert.ok(
    monitored.timers.every((timer) => timer.unit !== "daily-flow-upload.timer"),
  );
  const latest = cli(f, "status").latestSnapshotId;
  await writeFile(`${f.config.backupDir}/${latest}/data.tar.gz`, "damaged");
  assert.throws(() => cli(f, "status"), /LOCAL_BACKUP_CHANGED/);
  assert.throws(() => cli(f, "retention-apply"), /LOCAL_BACKUP_CHANGED/);
});
test("local retention keeps seven daily days and the latest release, and local copy restores in isolation", async (t) => {
  const f = await localFixture(t);
  let result = await f.control("backup", "--id", "source", "--kind", "daily");
  assert.equal(result.code, 0, result.output + result.error);
  async function copy(id, days, kind) {
    const directory = `${f.config.backupDir}/${id}`;
    await cp(`${f.config.backupDir}/source`, directory, { recursive: true });
    const manifest = JSON.parse(await readFile(directory + "/manifest.json"));
    Object.assign(manifest, {
      id,
      kind,
      snapshotAt: new Date(Date.now() - days * 86400000).toISOString(),
    });
    await writeFile(directory + "/manifest.json", JSON.stringify(manifest));
    await writeFile(
      directory + "/manifest.sha256",
      await sha256(directory + "/manifest.json"),
    );
  }
  await copy("daily-old", 8, "daily");
  await copy("daily-recent", 6, "daily");
  await copy("release-old", 4, "pre-release");
  await copy("release-latest", 2, "pre-release");
  const protectedMaterial = `${f.config.backupDir}/release-latest/data.tar.gz`;
  const originalMaterial = await readFile(protectedMaterial);
  await writeFile(protectedMaterial, "damaged retained pre-release");
  assert.throws(
    () => cli(f, "retention-apply"),
    /RETAINED_RECOVERY_POINT_INVALID/,
  );
  assert.ok((await readdir(f.config.backupDir)).includes("release-old"));
  await writeFile(protectedMaterial, originalMaterial);
  assert.deepEqual(cli(f, "retention-apply").localDelete.sort(), [
    "daily-old",
    "release-old",
  ]);
  assert.ok((await readdir(f.config.backupDir)).includes("release-latest"));
  const source = f.root + "/saved-local-copy";
  await rename(`${f.config.backupDir}/source`, source);
  f.config.recoveryMode = "isolated";
  await writeFile(f.root + "/deploy.json", JSON.stringify(f.config));
  assert.equal(cli(f, "import", "source", "--source", source).phase, "fetched");
  result = await f.control(
    "restore",
    "--id",
    "restore-local",
    "--snapshot",
    "source",
  );
  assert.equal(result.code, 0, result.output + result.error);
  const report = cli(f, "drill-verify", "source");
  assert.equal(report.phase, "verified");
  await writeFile(f.root + "/drill-report.json", JSON.stringify(report));
  assert.equal(
    JSON.parse(
      run(
        "node",
        "/repository/ops/record-drill.mjs",
        "--config",
        f.root + "/deploy.json",
        "--report",
        f.root + "/drill-report.json",
      ),
    ).phase,
    "recorded",
  );
  const success = await readFile(
    f.config.stateDir + "/last-drill-success.json",
    "utf8",
  );
  await writeFile(
    `${f.config.backupDir}/source/data.tar.gz`,
    "damaged after drill",
  );
  await writeFile(
    f.root + "/drill-report.json",
    JSON.stringify({
      ...report,
      phase: "failed",
      failedAt: new Date().toISOString(),
    }),
  );
  assert.equal(
    JSON.parse(
      run(
        "node",
        "/repository/ops/record-drill.mjs",
        "--config",
        f.root + "/deploy.json",
        "--report",
        f.root + "/drill-report.json",
      ),
    ).phase,
    "failure-recorded",
  );
  assert.equal(
    JSON.parse(await readFile(f.config.stateDir + "/latest-drill.json")).phase,
    "failed",
  );
  assert.equal(
    await readFile(f.config.stateDir + "/last-drill-success.json", "utf8"),
    success,
  );
});
