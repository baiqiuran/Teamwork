import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { offsite } from "./offsite-client.mjs";
import { durable, sha256 } from "../io.mjs";
import { destination } from "../offsite.mjs";

test("retention separately applies days and release count, protecting pending, restoring and final recovery points", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "retention-"));
  const config = {
    schema: 1,
    dataDir: root + "/data",
    stateDir: root + "/control",
    backupDir: root + "/backups",
    current: root + "/current",
    releases: root + "/releases",
    envFile: root + "/config.env",
    artifact: root + "/app.tar.gz",
    maintenance: root + "/maintenance",
    dataLock: root + "/data.lock",
    database: "data.sqlite",
    unit: "synthetic.service",
    serviceUser: "nobody",
    reserveBytes: 0,
    probeUrl: "http://127.0.0.1:1234/api/setup/status",
    ingressUrl: "http://127.0.0.1:1234",
    oss: {
      region: "cn-shanghai",
      hostRegion: "cn-guangzhou",
      bucket: "synthetic",
      prefix: "snapshots/",
      roleName: "test",
    },
  };
  for (const path of [
    config.dataDir,
    config.stateDir,
    config.backupDir,
    config.releases,
    config.stateDir + "/uploads",
    config.stateDir + "/operations",
  ])
    await mkdir(path, { recursive: true });
  await durable(root + "/deploy.json", config);
  async function snapshot(id, days, kind = "daily", phase = "verified") {
    const local = config.backupDir + "/" + id,
      remote = config.stateDir + "/synthetic-oss/snapshots/" + id;
    await mkdir(local);
    await mkdir(remote, { recursive: true });
    const manifest = {
      id,
      kind,
      snapshotAt: new Date(Date.now() - days * 86400000).toISOString(),
      materials: [],
    };
    for (const name of [
      "application.tar.gz",
      "config.env",
      "data.tar.gz",
      "node",
    ]) {
      await writeFile(local + "/" + name, "matching code");
      await writeFile(remote + "/" + name, "matching code");
      manifest.materials.push({
        name,
        sha256: await sha256(local + "/" + name),
      });
    }
    for (const path of [local, remote]) {
      await durable(path + "/manifest.json", manifest);
      await writeFile(path + "/application.tar.gz", "matching code");
    }
    const digest = await sha256(local + "/manifest.json");
    await writeFile(local + "/manifest.sha256", digest);
    await durable(remote + "/complete.json", {
      id,
      manifestDigest: digest,
      files: [],
    });
    await durable(config.stateDir + "/uploads/" + id + ".json", {
      ...manifest,
      phase,
      attempts: 0,
      destination: destination(config),
      manifestDigest: digest,
    });
  }
  await snapshot("daily-old", 40);
  await snapshot("daily-local-expired", 8);
  await snapshot("daily-recent", 1);
  await snapshot("pending", 40, "daily", "failed");
  await snapshot("restoring", 40);
  await snapshot("last", 0);
  for (let n = 0; n < 12; n++)
    await snapshot("release-" + n, n + 1, "pre-release");
  await durable(config.stateDir + "/operations/restore.json", {
    command: "restore",
    phase: "data-operation",
    snapshot: "restoring",
  });
  let result = await offsite(root + "/deploy.json", "retention-plan");
  assert.equal(result.code, 0, result.output + result.error);
  const plan = JSON.parse(result.output);
  assert.ok(plan.localDelete.includes("daily-old"));
  assert.ok(plan.localDelete.includes("daily-local-expired"));
  assert.ok(!plan.remoteDelete.includes("daily-local-expired"));
  assert.ok(plan.remoteDelete.includes("release-11"));
  assert.ok(!plan.remoteDelete.includes("release-9"));
  for (const protectedId of ["pending", "restoring", "last"]) {
    assert.ok(!plan.localDelete.includes(protectedId));
    assert.ok(!plan.remoteDelete.includes(protectedId));
  }
  // A real held operation lock prevents cleanup while recovery is running.
  await durable(config.stateDir + "/operation.lock", { id: "restore" });
  result = await offsite(root + "/deploy.json", "retention-apply");
  assert.notEqual(result.code, 0);
  await access(config.backupDir + "/daily-old/application.tar.gz");
  await rm(config.stateDir + "/operation.lock");
  await durable(config.stateDir + "/operations/restore.json", {
    command: "restore",
    phase: "completed",
    snapshot: "restoring",
  });
  await durable(
    config.stateDir +
      "/synthetic-oss/snapshots/restoring/restore-pin-isolated.json",
    { startedAt: new Date().toISOString() },
  );
  for (const damaged of [
    config.backupDir + "/last/data.tar.gz",
    config.stateDir + "/synthetic-oss/snapshots/last/data.tar.gz",
  ]) {
    await writeFile(damaged, "corrupt");
    result = await offsite(root + "/deploy.json", "retention-apply");
    assert.notEqual(result.code, 0);
    await access(config.backupDir + "/daily-old/application.tar.gz");
    await access(
      config.stateDir + "/synthetic-oss/snapshots/daily-old/complete.json",
    );
    await writeFile(damaged, "matching code");
  }
  result = await offsite(root + "/deploy.json", "retention-apply");
  assert.equal(result.code, 0, result.output + result.error);
  await assert.rejects(access(config.backupDir + "/daily-old"));
  await assert.rejects(
    access(
      config.stateDir + "/synthetic-oss/snapshots/daily-old/complete.json",
    ),
  );
  for (const id of ["pending", "restoring", "last"])
    await access(config.backupDir + "/" + id + "/application.tar.gz");
  await access(
    config.stateDir +
      "/synthetic-oss/snapshots/daily-local-expired/complete.json",
  );
});
