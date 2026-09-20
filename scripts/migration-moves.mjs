import assert from "node:assert/strict";

export function fileBlob(git, commit, path) {
  const line = git("ls-tree", commit, "--", path);
  if (!line) return undefined;
  const match = line.match(/^100(?:644|755) blob ([a-f0-9]{40})\t/);
  assert.ok(match, `MIGRATION_FILE_INVALID: ${commit}:${path}`);
  return match[1];
}

export function previousBlob(git, commit, path) {
  const parents = git("rev-list", "--parents", "-n", "1", commit)
    .split(" ")
    .slice(1);
  const blobs = new Set(
    parents.map((parent) => fileBlob(git, parent, path)).filter(Boolean),
  );
  assert.equal(
    blobs.size,
    1,
    `MIGRATION_MOVE_INVALID: ambiguous prior file ${commit}:${path}`,
  );
  return [...blobs][0];
}

export function verifyMove(git, commit, path, note) {
  assert.ok(
    note?.replacement?.startsWith("server/") &&
      note.replacement !== path &&
      note.replacement.includes("/infrastructure/") &&
      !note.replacement.split("/").includes("..") &&
      /^[a-f0-9]{40}$/.test(note.replacementBlob ?? ""),
    `MIGRATION_MOVE_INVALID: missing replacement for ${commit}:${path}`,
  );
  assert.equal(
    fileBlob(git, commit, note.replacement),
    note.replacementBlob,
    `MIGRATION_MOVE_INVALID: replacement mismatch ${commit}:${path}`,
  );
  assert.equal(
    previousBlob(git, commit, path),
    note.previousBlob,
    `MIGRATION_MOVE_INVALID: prior file mismatch ${commit}:${path}`,
  );
}
