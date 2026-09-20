import assert from "node:assert/strict";
import { open, rename, readFile, readdir, lstat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve, relative } from "node:path";

export const json = async (path) => JSON.parse(await readFile(path, "utf8"));
export async function syncPath(path) {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function durable(path, value, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.partial`;
  const file = await open(temporary, "wx", mode);
  try {
    await file.writeFile(
      typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
    );
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await syncPath(dirname(path));
}
export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function inventory(root) {
  const result = [];
  async function walk(path) {
    const item = await lstat(path);
    assert.ok(
      !item.isSymbolicLink(),
      "SYMLINK_IN_DATA: cannot snapshot an external target",
    );
    if (item.isDirectory())
      for (const name of await readdir(path)) await walk(resolve(path, name));
    else {
      assert.ok(item.isFile(), "Unsupported data file");
      result.push({
        path: relative(root, path).replaceAll("\\", "/"),
        bytes: item.size,
        sha256: await sha256(path),
      });
    }
  }
  await walk(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
