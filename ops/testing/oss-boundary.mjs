// Synthetic cloud boundary; injected by Node module hooks in isolated tests only.
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
  readdir,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { sha256 } from "../io.mjs";
export async function createStore(config) {
  const root = resolve(config.stateDir, "synthetic-oss");
  async function fault() {
    try {
      return await readFile(resolve(root, "fault"), "utf8");
    } catch {
      return "";
    }
  }
  return {
    async check() {
      if ((await fault()) === "slow-offline") {
        const now = Date.now();
        Date.now = () => now + 300000;
        throw new Error("OSS_OFFLINE");
      }
      if ((await fault()) === "offline") throw new Error("OSS_OFFLINE");
    },
    async put(key, file) {
      const path = resolve(root, key);
      await mkdir(dirname(path), { recursive: true });
      if (Buffer.isBuffer(file)) await writeFile(path, file);
      else await copyFile(file, path);
    },
    async digest(key) {
      return (await fault()) === "corrupt"
        ? "wrong"
        : sha256(resolve(root, key));
    },
    async get(key, path) {
      await copyFile(resolve(root, key), path);
    },
    async remove(key) {
      await rm(resolve(root, key), { force: true });
    },
    async list(prefix) {
      const names = await readdir(resolve(root, prefix), {
        recursive: true,
        withFileTypes: true,
      });
      return names
        .filter((x) => x.isFile())
        .map((x) => resolve(x.parentPath, x.name).slice(root.length + 1));
    },
  };
}
