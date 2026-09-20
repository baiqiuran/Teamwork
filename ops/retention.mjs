import assert from "node:assert/strict";
import { readdir, mkdtemp, rm, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { json, sha256, durable } from "./io.mjs";
import { jobs, destination } from "./offsite.mjs";
import { exists } from "./host.mjs";
import { processIdentity } from "./process-identity.mjs";
const validId = (id) => /^[a-zA-Z0-9_-]{1,80}$/.test(id);

export async function withControlLock(config, id, work) {
  const path = resolve(config.stateDir, "operation.lock");
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("OPERATION_BUSY");
    throw error;
  }
  try {
    await file.writeFile(JSON.stringify({ id, ...(await processIdentity()) }));
    await file.sync();
    for (const name of await readdir(resolve(config.stateDir, "operations"))) {
      if (!name.endsWith(".json")) continue;
      assert.ok(
        ["completed", "failed"].includes(
          (await json(resolve(config.stateDir, "operations", name))).phase,
        ),
        "PENDING_OPERATION_RECONCILIATION",
      );
    }
    return await work();
  } finally {
    await file.close();
    await rm(path);
  }
}
export async function remoteIndex(config, store) {
  await store.check();
  const keys = await store.list(config.oss.prefix);
  const snapshots = [],
    pins = new Set();
  const temporary = await mkdtemp(resolve(config.stateDir, ".remote-index-"));
  try {
    for (const key of keys) {
      assert.ok(key.startsWith(config.oss.prefix), "UNEXPECTED_REMOTE_PREFIX");
      const [id, name, ...rest] = key
        .slice(config.oss.prefix.length)
        .split("/");
      if (!validId(id) || !name || rest.length) continue;
      if (name.startsWith("restore-pin-")) pins.add(id);
      if (name !== "complete.json") continue;
      const markerPath = resolve(temporary, "complete.json"),
        manifestPath = resolve(temporary, "manifest.json");
      await store.get(key, markerPath);
      const marker = await json(markerPath);
      assert.equal(marker.id, id);
      await store.get(`${config.oss.prefix}${id}/manifest.json`, manifestPath);
      assert.equal(
        await sha256(manifestPath),
        marker.manifestDigest,
        "REMOTE_MANIFEST_MISMATCH",
      );
      const manifest = await json(manifestPath);
      assert.equal(manifest.id, id);
      assert.ok(
        Number.isFinite(Date.parse(manifest.snapshotAt)),
        "INVALID_SNAPSHOT_TIME",
      );
      snapshots.push(manifest);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { snapshots, pins, keys };
}
function deletions(records, days, releases, protectedIds, now) {
  const sorted = [...records].sort(
    (a, b) => Date.parse(b.snapshotAt) - Date.parse(a.snapshotAt),
  );
  const keep = new Set(protectedIds);
  if (sorted[0]) keep.add(sorted[0].id);
  for (const entry of sorted
    .filter((x) => x.kind === "pre-release")
    .slice(0, releases))
    keep.add(entry.id);
  return sorted
    .filter(
      (x) =>
        !keep.has(x.id) &&
        ((x.kind === "daily" &&
          now - Date.parse(x.snapshotAt) > days * 86400000) ||
          x.kind === "pre-release"),
    )
    .map((x) => x.id);
}
export async function planRetention(config, store) {
  const local = [];
  const queue = await jobs(config),
    target = destination(config);
  const protectedIds = new Set(
    queue
      .filter(
        (j) =>
          !["verified", "retired"].includes(j.phase) ||
          j.destination !== target,
      )
      .map((j) => j.id),
  );
  for (const entry of await readdir(config.backupDir, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || !validId(entry.name)) continue;
    const manifest = await json(
      resolve(config.backupDir, entry.name, "manifest.json"),
    );
    assert.equal(manifest.id, entry.name);
    assert.equal(
      await sha256(resolve(config.backupDir, entry.name, "manifest.json")),
      (
        await readFile(
          resolve(config.backupDir, entry.name, "manifest.sha256"),
          "utf8",
        )
      ).trim(),
      "LOCAL_MANIFEST_MISMATCH",
    );
    local.push(manifest);
    if (!queue.some((j) => j.id === entry.name)) protectedIds.add(entry.name);
  }
  for (const name of await readdir(resolve(config.stateDir, "operations"))) {
    if (!name.endsWith(".json")) continue;
    const operation = await json(resolve(config.stateDir, "operations", name));
    if (!["completed", "failed"].includes(operation.phase))
      for (const id of [operation.snapshot, operation.snapshotId])
        if (id) protectedIds.add(id);
  }
  const remote = await remoteIndex(config, store);
  for (const id of remote.pins) protectedIds.add(id);
  const localDelete = deletions(local, 7, 1, protectedIds, Date.now());
  const remoteDelete = deletions(
    remote.snapshots,
    30,
    10,
    protectedIds,
    Date.now(),
  );
  // Materials are owned by their snapshot directory; live releases and
  // incident evidence never enter this cleanup set.
  return {
    localDelete,
    remoteDelete,
    protected: [...protectedIds],
    retainedMaterials: local
      .filter((m) => !localDelete.includes(m.id))
      .map((m) => ({
        id: m.id,
        materials: m.materials.map((f) => `${m.id}/${f.name}`),
      })),
  };
}
export async function applyRetention(config, store) {
  return withControlLock(config, "retention", async () => {
    await store.check();
    const token = await store.lock();
    try {
      const plan = await planRetention(config, store);
      const remote = await remoteIndex(config, store);
      for (const id of plan.remoteDelete) {
        assert.ok(validId(id));
        await store.remove(`${config.oss.prefix}${id}/complete.json`);
        for (const key of remote.keys.filter(
          (k) =>
            k.startsWith(`${config.oss.prefix}${id}/`) &&
            !k.endsWith("/complete.json"),
        ))
          await store.remove(key);
        const path = resolve(config.stateDir, "uploads", `${id}.json`);
        if (await exists(path))
          await durable(path, {
            ...(await json(path)),
            phase: "retired",
            retiredAt: new Date().toISOString(),
          });
      }
      for (const id of plan.localDelete) {
        assert.ok(validId(id));
        await rm(resolve(config.backupDir, id), { recursive: true });
      }
      await durable(resolve(config.stateDir, "retention.json"), {
        ...plan,
        completedAt: new Date().toISOString(),
      });
      return plan;
    } finally {
      await store.unlock(token);
    }
  });
}
