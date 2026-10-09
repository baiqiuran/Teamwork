import assert from "node:assert/strict";
import { test } from "node:test";
import { manualFixture } from "./manual-fixture.mjs";
import { run } from "./fixture.mjs";
import { json, sha256 } from "../io.mjs";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";

async function expire(f, id = "baseline-backup") {
  const path = `${f.config.backupDir}/${id}/manifest.json`;
  const manifest = await json(path);
  await writeFile(
    path,
    JSON.stringify({
      ...manifest,
      snapshotAt: new Date(Date.now() - 25 * 3600000).toISOString(),
    }),
  );
  await writeFile(
    `${f.config.backupDir}/${id}/manifest.sha256`,
    await sha256(path),
  );
}

async function assertRefused(f, id, candidate, pid) {
  const result = await f.control(
    "manual-release",
    "--id",
    id,
    "--candidate",
    candidate,
    "--baseline",
    f.baseline,
  );
  assert.equal(result.code, 1, result.output + result.error);
  assert.equal(
    run("systemctl", "show", f.config.unit, "-p", "MainPID", "--value").trim(),
    pid,
  );
  const record = await json(`${f.config.stateDir}/operations/${id}.json`);
  assert.equal(record.phase, "failed");
  assert.equal(record.maintenanceAt, undefined);
  assert.equal(record.recovery, "not-needed");
  assert.equal(
    (await fetch(`${f.origin}/health/ready`).then((r) => r.json())).version,
    f.baseline,
  );
  return record;
}

test("manual release without a fresh local snapshot refuses before stopping the current service", async (t) => {
  const f = await manualFixture(t, { freshSnapshot: false });
  const candidate = await f.candidate("missing-snapshot");
  const pid = run(
    "systemctl",
    "show",
    f.config.unit,
    "-p",
    "MainPID",
    "--value",
  ).trim();
  const record = await assertRefused(f, "missing-snapshot", candidate, pid);
  assert.equal(record.failure, "LOCAL_BACKUP_EXPIRED_OR_MISSING");
});

for (const fault of ["expired", "corrupt", "copied"]) {
  test(`manual release rejects a ${fault} snapshot without changing the running service`, async (t) => {
    const f = await manualFixture(t);
    const candidate = await f.candidate(fault);
    if (fault === "corrupt") {
      await writeFile(
        `${f.config.backupDir}/baseline-backup/data.tar.gz`,
        "broken snapshot",
      );
    } else {
      await expire(f);
      if (fault === "copied") {
        const copy = `${f.config.backupDir}/recent-copy`;
        await cp(`${f.config.backupDir}/baseline-backup`, copy, {
          recursive: true,
        });
        const manifest = await json(`${copy}/manifest.json`);
        await writeFile(
          `${copy}/manifest.json`,
          JSON.stringify({ ...manifest, id: "recent-copy" }),
        );
        await writeFile(
          `${copy}/manifest.sha256`,
          await sha256(`${copy}/manifest.json`),
        );
      }
    }
    const pid = run(
      "systemctl",
      "show",
      f.config.unit,
      "-p",
      "MainPID",
      "--value",
    ).trim();
    const record = await assertRefused(f, fault, candidate, pid);
    assert.match(
      record.failure,
      fault === "corrupt"
        ? /^LOCAL_BACKUP_CHANGED(?:\n|$)/
        : /^LOCAL_BACKUP_EXPIRED_OR_MISSING$/,
    );
  });
}

test("snapshot expiring during real candidate startup is rejected before maintenance", async (t) => {
  const f = await manualFixture(t);
  const gateDirectory = `${f.root}/candidate-startup-gate`;
  await mkdir(gateDirectory);
  await chmod(gateDirectory, 0o777);
  const marker = `${gateDirectory}/started`,
    proceed = `${gateDirectory}/proceed`;
  const candidate = await f.candidate("late-expiry", async (runtime) => {
    const path = `${runtime}/build/server/main.js`;
    await writeFile(
      path,
      `const gateFs = await import("node:fs"); gateFs.writeFileSync(${JSON.stringify(marker)}, "started"); while(!gateFs.existsSync(${JSON.stringify(proceed)})) await new Promise(r=>setTimeout(r,25));\n${await readFile(path, "utf8")}`,
    );
  });
  const pid = run(
    "systemctl",
    "show",
    f.config.unit,
    "-p",
    "MainPID",
    "--value",
  ).trim();
  const release = assertRefused(f, "late-expiry", candidate, pid);
  // The child may fail before reaching its gate; always collect that outcome.
  release.catch(() => {});
  try {
    let started = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await access(marker);
        started = true;
        break;
      } catch {}
      await new Promise((done) => setTimeout(done, 25));
    }
    assert.ok(started, "real candidate must reach its startup gate");
    await expire(f);
  } finally {
    await writeFile(proceed, "continue");
    await release;
  }
  const record = await release;
  assert.equal(record.failure, "LOCAL_BACKUP_EXPIRED_OR_MISSING");
  assert.ok(
    record.target,
    "candidate preparation completed before the second check refused",
  );
});
