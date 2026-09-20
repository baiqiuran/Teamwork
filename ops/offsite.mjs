import assert from "node:assert/strict";
import { mkdir, readdir, readFile, link, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { durable, json, sha256, syncPath } from "./io.mjs";
import { exists } from "./host.mjs";

export function destination(config) {
  const value = config.oss;
  assert.ok(value, "OSS_NOT_CONFIGURED");
  assert.match(value.region, /^cn-(?!hongkong$)[a-z0-9-]+$/);
  assert.notEqual(
    value.region,
    value.hostRegion,
    "OSS_MUST_BE_IN_ANOTHER_REGION",
  );
  assert.match(value.hostRegion, /^cn-[a-z0-9-]+$/);
  assert.match(value.bucket, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
  assert.match(value.prefix, /^[a-zA-Z0-9_-]+\/$/);
  assert.match(value.roleName, /^[a-zA-Z0-9.@_-]+$/);
  return createHash("sha256")
    .update(JSON.stringify([value.region, value.bucket, value.prefix]))
    .digest("hex");
}
export async function jobs(config) {
  const directory = resolve(config.stateDir, "uploads");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return Promise.all(
    (await readdir(directory))
      .filter((n) => n.endsWith(".json"))
      .map((n) => json(resolve(directory, n))),
  );
}
export async function enqueue(config, id) {
  assert.match(id, /^[a-zA-Z0-9_-]{1,80}$/);
  const directory = resolve(config.backupDir, id);
  const digest = await sha256(resolve(directory, "manifest.json"));
  assert.equal(
    digest,
    (await readFile(resolve(directory, "manifest.sha256"), "utf8")).trim(),
  );
  const manifest = await json(resolve(directory, "manifest.json"));
  assert.equal(manifest.id, id);
  const files = [
    ...manifest.materials,
    { name: "manifest.json", sha256: digest },
    {
      name: "manifest.sha256",
      sha256: await sha256(resolve(directory, "manifest.sha256")),
    },
  ];
  for (const file of files)
    assert.equal(
      await sha256(resolve(directory, file.name)),
      file.sha256,
      "LOCAL_BACKUP_CHANGED",
    );
  await jobs(config);
  const path = resolve(config.stateDir, "uploads", `${id}.json`);
  if (await exists(path)) {
    assert.equal(
      (await json(path)).manifestDigest,
      digest,
      "UPLOAD_ID_CONFLICT",
    );
    return;
  }
  const temporary = `${path}.${randomUUID()}.pending`;
  await durable(temporary, {
    id,
    phase: "pending",
    attempts: 0,
    snapshotAt: manifest.snapshotAt,
    kind: manifest.kind,
    commit: manifest.commit,
    manifestDigest: digest,
    files,
  });
  try {
    await link(temporary, path);
    await syncPath(resolve(config.stateDir, "uploads"));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert.equal(
      (await json(path)).manifestDigest,
      digest,
      "UPLOAD_ID_CONFLICT",
    );
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function reconcileQueue(config) {
  for (const entry of await readdir(config.backupDir, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.name))
      continue;
    if (await exists(resolve(config.stateDir, "uploads", `${entry.name}.json`)))
      continue;
    await enqueue(config, entry.name);
  }
}
export async function report(config, operation) {
  if (!operation.snapshotId) return operation;
  const path = resolve(
    config.stateDir,
    "uploads",
    `${operation.snapshotId}.json`,
  );
  const job = (await exists(path))
    ? await json(path)
    : { phase: "pending-reconciliation" };
  return {
    ...operation,
    offsite: {
      ...(config.oss ? await status(config) : { backup: "not-configured" }),
      snapshot: {
        id: operation.snapshotId,
        phase: job.phase,
        failure: job.failure,
        nextAttemptAt: job.nextAttemptAt,
      },
    },
  };
}
export async function status(config, now = Date.now()) {
  const target = destination(config);
  const queue = await jobs(config);
  const valid = queue.filter(
    (job) =>
      job.phase === "verified" &&
      job.destination === target &&
      Number.isFinite(Date.parse(job.snapshotAt)) &&
      Date.parse(job.snapshotAt) <= now,
  );
  valid.sort((a, b) => Date.parse(b.snapshotAt) - Date.parse(a.snapshotAt));
  const latest = valid[0];
  return {
    application: "unchanged",
    backup: latest ? "verified" : "missing",
    latestSnapshotAt: latest?.snapshotAt,
    latestSnapshotId: latest?.id,
    ageMilliseconds: latest ? now - Date.parse(latest.snapshotAt) : null,
    fresh: !!latest && now - Date.parse(latest.snapshotAt) <= 86400000,
    pending: queue.filter((j) => j.phase !== "verified").length,
    failures: queue
      .filter((j) => j.phase === "failed")
      .map((j) => ({
        id: j.id,
        failure: j.failure,
        nextAttemptAt: j.nextAttemptAt,
      })),
  };
}
export async function requireFresh(config) {
  const result = await status(config);
  assert.ok(result.fresh, "OFFSITE_BACKUP_EXPIRED_OR_MISSING");
  return result;
}
export async function upload(config, store) {
  const target = destination(config);
  await reconcileQueue(config);
  const results = [];
  for (let job of await jobs(config)) {
    if (
      job.phase === "verified" ||
      Date.parse(job.nextAttemptAt ?? "") > Date.now()
    )
      continue;
    const path = resolve(config.stateDir, "uploads", `${job.id}.json`);
    job = {
      ...job,
      phase: "uploading",
      attempts: job.attempts + 1,
      destination: target,
    };
    await durable(path, job);
    try {
      await store.check();
      const directory = resolve(config.backupDir, job.id);
      for (const file of job.files) {
        const local = resolve(directory, file.name);
        assert.equal(await sha256(local), file.sha256, "LOCAL_BACKUP_CHANGED");
        const key = `${config.oss.prefix}${job.id}/${file.name}`;
        await store.put(key, local);
        assert.equal(
          await store.digest(key),
          file.sha256,
          "REMOTE_CHECKSUM_MISMATCH",
        );
      }
      // The completion marker is written last; readers ignore partial prefixes.
      const marker = Buffer.from(
        JSON.stringify({
          id: job.id,
          manifestDigest: job.manifestDigest,
          files: job.files,
        }),
      );
      const markerKey = `${config.oss.prefix}${job.id}/complete.json`;
      await store.put(markerKey, marker);
      assert.equal(
        await store.digest(markerKey),
        createHash("sha256").update(marker).digest("hex"),
        "REMOTE_CHECKSUM_MISMATCH",
      );
      job = {
        ...job,
        phase: "verified",
        verifiedAt: new Date().toISOString(),
        failure: undefined,
        nextAttemptAt: undefined,
      };
    } catch (error) {
      // SDK error messages can contain signed request details. Persist only a code.
      const known = [
        "LOCAL_BACKUP_CHANGED",
        "REMOTE_CHECKSUM_MISMATCH",
        "OSS_BUCKET_NOT_PRIVATE",
        "OSS_ENCRYPTION_MISSING",
      ].find((code) => String(error.message).startsWith(code));
      const code =
        known ?? String(error.code ?? error.message ?? "UPLOAD_FAILED");
      job = {
        ...job,
        phase: "failed",
        failure: /^[A-Z][A-Z0-9_]{0,79}$/.test(code)
          ? code
          : "OSS_UPLOAD_FAILED",
        nextAttemptAt: new Date(
          Date.now() +
            Math.min(3600000, 60000 * 2 ** Math.min(job.attempts - 1, 6)),
        ).toISOString(),
      };
    }
    await durable(path, job);
    results.push({ id: job.id, phase: job.phase, failure: job.failure });
  }
  return results;
}
