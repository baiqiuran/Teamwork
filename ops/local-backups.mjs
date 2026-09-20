import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { json, sha256 } from "./io.mjs";

// Legacy cloud configurations remain readable; new installations use local mode.
export const localOnly = (config) =>
  config.backupMode === "local" || !config.oss;
export async function localStatus(config, now = Date.now()) {
  const manifests = [];
  for (const entry of await readdir(config.backupDir, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.name))
      continue;
    const directory = resolve(config.backupDir, entry.name);
    const manifest = await json(resolve(directory, "manifest.json"));
    assert.equal(manifest.id, entry.name, "LOCAL_MANIFEST_MISMATCH");
    assert.equal(
      await sha256(resolve(directory, "manifest.json")),
      (await readFile(resolve(directory, "manifest.sha256"), "utf8")).trim(),
      "LOCAL_MANIFEST_MISMATCH",
    );
    assert.ok(
      Number.isFinite(Date.parse(manifest.snapshotAt)) &&
        Date.parse(manifest.snapshotAt) <= now,
      "INVALID_LOCAL_SNAPSHOT_TIME",
    );
    manifests.push(manifest);
  }
  manifests.sort((a, b) => Date.parse(b.snapshotAt) - Date.parse(a.snapshotAt));
  const latest = manifests[0];
  if (latest) {
    assert.deepEqual(
      latest.materials.map((f) => f.name).sort(),
      ["application.tar.gz", "config.env", "data.tar.gz", "node"],
      "LOCAL_MATERIALS_INVALID",
    );
    for (const file of latest.materials)
      assert.equal(
        await sha256(resolve(config.backupDir, latest.id, file.name)),
        file.sha256,
        "LOCAL_BACKUP_CHANGED",
      );
  }
  return {
    mode: "local",
    backup: latest ? "verified" : "missing",
    latestSnapshotId: latest?.id,
    latestSnapshotAt: latest?.snapshotAt,
    ageMilliseconds: latest ? now - Date.parse(latest.snapshotAt) : null,
    fresh: !!latest && now - Date.parse(latest.snapshotAt) <= 86400000,
    pending: 0,
    failures: [],
  };
}
