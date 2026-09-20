import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  chmod,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { json, durable, inventory, sha256, syncPath } from "./io.mjs";
import { capacity, command } from "./host.mjs";

async function databaseState(config, directory) {
  const db = new DatabaseSync(resolve(directory, config.database), {
    readOnly: true,
  });
  try {
    assert.equal(
      db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
      "SQLITE_INTEGRITY_FAILED",
    );
    assert.equal(
      db.prepare("PRAGMA foreign_key_check").all().length,
      0,
      "SQLITE_FOREIGN_KEYS_FAILED",
    );
    const attachments = db.prepare("SELECT * FROM attachments").all();
    for (const attachment of attachments) {
      assert.match(attachment.id, /^[0-9a-f-]{36}$/i);
      const bytes = await readFile(
        resolve(directory, "attachments", attachment.id),
      );
      assert.equal(bytes.length, attachment.size, "ATTACHMENT_SIZE_MISMATCH");
      assert.equal(
        createHash("sha256")
          .update(
            `${attachment.diary_id}:${attachment.entry_id}:${attachment.name}:${bytes.toString("base64")}`,
          )
          .digest("hex"),
        attachment.fingerprint,
        "ATTACHMENT_BYTES_MISMATCH",
      );
    }
    const ids = new Set(attachments.map((file) => file.id));
    for (const diary of db.prepare("SELECT draft,published FROM diaries").all())
      for (const body of [diary.draft, diary.published].filter(Boolean))
        for (const entry of JSON.parse(body).entries)
          for (const ref of entry.attachments ?? [])
            assert.ok(ids.has(ref.id), "ATTACHMENT_REFERENCE_MISSING");
    return {
      databaseVersion: db
        .prepare(
          "SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations",
        )
        .get().version,
      attachments: attachments.length,
    };
  } finally {
    db.close();
  }
}
export function archiveSize(archive) {
  const paths = command("/usr/bin/tar", "-tzf", archive)
    .split("\n")
    .filter(Boolean);
  assert.ok(
    paths.every(
      (path) => !path.startsWith("/") && !path.split("/").includes(".."),
    ),
    "UNSAFE_ARCHIVE_PATH",
  );
  const entries = command("/usr/bin/tar", "--numeric-owner", "-tvzf", archive)
    .split("\n")
    .filter(Boolean);
  assert.ok(
    entries.every((line) => ["-", "d"].includes(line[0])),
    "UNSAFE_ARCHIVE_LINK",
  );
  const size = entries.reduce((sum, line) => {
    const bytes = Number(line.trim().split(/\s+/)[2]);
    assert.ok(
      Number.isSafeInteger(bytes) && bytes >= 0,
      "INVALID_ARCHIVE_SIZE",
    );
    // Allow allocation overhead for small files and directories as well.
    return sum + Math.ceil(bytes / 4096) * 4096 + 4096;
  }, 0);
  assert.ok(Number.isSafeInteger(size), "INVALID_ARCHIVE_SIZE");
  return size;
}
export function extract(archive, directory) {
  archiveSize(archive);
  command(
    "/usr/bin/tar",
    "--no-same-owner",
    "--no-same-permissions",
    "-xzf",
    archive,
    "-C",
    directory,
  );
}
export async function backup(config, operation) {
  const initialFiles = await inventory(config.dataDir);
  const bytes = initialFiles.reduce((sum, file) => sum + file.bytes, 0);
  const runtimeBytes =
    (await stat(config.artifact)).size + (await stat(process.execPath)).size;
  await capacity(config, bytes * 3 + runtimeBytes * 2);
  const partial = resolve(config.backupDir, `.${operation.id}.partial`);
  await mkdir(partial, { mode: 0o700 });
  await cp(config.dataDir, resolve(partial, "data"), { recursive: true });
  const state = await databaseState(config, resolve(partial, "data"));
  const files = await inventory(resolve(partial, "data"));
  const manifest = await json(resolve(config.current, "release.json"));
  const archiveManifest = JSON.parse(
    command("/usr/bin/tar", "-xOzf", config.artifact, "release.json"),
  );
  assert.deepEqual(archiveManifest, manifest, "ACTIVE_ARTIFACT_MISMATCH");
  assert.equal(manifest.node, process.version, "RUNTIME_MISMATCH");
  command(
    "/usr/bin/tar",
    "-czf",
    resolve(partial, "data.tar.gz"),
    "-C",
    resolve(partial, "data"),
    ".",
  );
  await cp(config.artifact, resolve(partial, "application.tar.gz"));
  await cp(process.execPath, resolve(partial, "node"));
  await cp(config.envFile, resolve(partial, "config.env"));
  const materials = [];
  for (const name of [
    "data.tar.gz",
    "application.tar.gz",
    "node",
    "config.env",
  ]) {
    await chmod(resolve(partial, name), 0o600);
    await syncPath(resolve(partial, name));
    materials.push({
      name,
      sha256: await sha256(resolve(partial, name)),
      bytes: (await stat(resolve(partial, name))).size,
    });
  }
  const record = {
    schema: 1,
    id: operation.id,
    kind: operation.kind,
    snapshotAt: operation.stoppedAt,
    commit: manifest.commit,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    ...state,
    files,
    materials,
  };
  await durable(resolve(partial, "manifest.json"), record);
  await durable(
    resolve(partial, "manifest.sha256"),
    await sha256(resolve(partial, "manifest.json")),
  );
  // Read the archive back before declaring it a usable recovery point.
  const unpacked = await validate(config, partial);
  await rm(unpacked, { recursive: true, force: true });
  await rm(resolve(partial, "data"), { recursive: true, force: true });
  await rename(partial, resolve(config.backupDir, operation.id));
  await syncPath(config.backupDir);
  return record;
}
export async function validate(
  config,
  snapshot,
  stagingParent = config.stateDir,
) {
  assert.equal(
    await sha256(resolve(snapshot, "manifest.json")),
    (await readFile(resolve(snapshot, "manifest.sha256"), "utf8")).trim(),
    "SNAPSHOT_CHECKSUM: manifest",
  );
  const manifest = await json(resolve(snapshot, "manifest.json"));
  assert.equal(manifest.schema, 1);
  assert.match(manifest.id, /^[a-zA-Z0-9_-]{1,80}$/);
  assert.match(manifest.commit, /^[a-f0-9]{40}$/);
  assert.equal(manifest.node, process.version, "RUNTIME_MISMATCH");
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.architecture, process.arch);
  assert.deepEqual(manifest.materials.map((file) => file.name).sort(), [
    "application.tar.gz",
    "config.env",
    "data.tar.gz",
    "node",
  ]);
  for (const file of manifest.materials)
    assert.equal(
      await sha256(resolve(snapshot, file.name)),
      file.sha256,
      `SNAPSHOT_CHECKSUM: ${file.name}`,
    );
  assert.equal(
    await sha256(process.execPath),
    manifest.materials.find((file) => file.name === "node").sha256,
    "RUNTIME_BINARY_MISMATCH",
  );
  // Budget expanded data and runtime before the first temporary extraction,
  // including filesystems distinct from the live data filesystem.
  const required =
    archiveSize(resolve(snapshot, "data.tar.gz")) * 2 +
    archiveSize(resolve(snapshot, "application.tar.gz")) * 2 +
    manifest.materials.reduce((sum, file) => sum + file.bytes, 0);
  await capacity(config, required, [stagingParent, dirname(config.dataDir)]);
  const staging = await mkdtemp(resolve(stagingParent, ".validated-"));
  try {
    extract(resolve(snapshot, "data.tar.gz"), staging);
    assert.deepEqual(
      await inventory(staging),
      manifest.files,
      "SNAPSHOT_CHECKSUM: data files",
    );
    await databaseState(config, staging);
    return staging;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
export async function restore(config, operation) {
  const snapshot = resolve(config.backupDir, operation.snapshot);
  const manifest = await json(resolve(snapshot, "manifest.json"));
  assert.equal(manifest.id, operation.snapshot, "SNAPSHOT_ID_MISMATCH");
  const staging = await validate(config, snapshot, dirname(config.dataDir));
  const release = resolve(config.releases, `restored-${operation.id}`);
  await mkdir(release, { mode: 0o755 });
  extract(resolve(snapshot, "application.tar.gz"), release);
  command("/bin/chmod", "-R", "a-s,a+rX", release);
  assert.equal(
    (await json(resolve(release, "release.json"))).commit,
    manifest.commit,
    "RESTORE_CODE_MISMATCH",
  );
  command("/usr/bin/chown", "-R", config.serviceUser, staging);
  await chmod(staging, 0o750);
  for (const file of await inventory(staging))
    await syncPath(resolve(staging, file.path));
  await syncPath(staging);
  // Preserve the replaced data as incident evidence instead of deleting it.
  await rename(
    config.dataDir,
    `${config.dataDir}.before-restore-${operation.id}`,
  );
  await rename(staging, config.dataDir);
  await syncPath(dirname(config.dataDir));
  await durable(
    config.envFile,
    await readFile(resolve(snapshot, "config.env"), "utf8"),
  );
  const next = `${config.current}.${operation.id}`;
  await symlink(release, next);
  await rename(next, config.current);
  await syncPath(dirname(config.current));
  if (config.slots && config.activeSlot) {
    const link = config.slots[config.activeSlot].link;
    const stagedLink = `${link}.${operation.id}`;
    await symlink(release, stagedLink);
    await rename(stagedLink, link);
    await syncPath(dirname(link));
  }
  const artifact = resolve(release, "application.tar.gz");
  await cp(resolve(snapshot, "application.tar.gz"), artifact);
  await syncPath(artifact);
  await durable(resolve(config.stateDir, "runtime.json"), {
    commit: manifest.commit,
    artifact,
    ...(config.activeSlot ? { slot: config.activeSlot } : {}),
  });
  return manifest;
}
