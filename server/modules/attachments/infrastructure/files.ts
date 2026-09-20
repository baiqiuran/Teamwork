import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  accessSync,
  constants,
} from "node:fs";
import { resolve } from "node:path";
import type { FileStorage } from "../application/ports.ts";
export function assertStorageAccessible(directory: string) {
  accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
}
export function localFiles(directory: string): FileStorage {
  mkdirSync(directory, { recursive: true });
  function path(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new Error("Invalid attachment storage key");
    return resolve(directory, id);
  }
  return {
    write: (id, bytes) => writeFileSync(path(id), bytes, { flag: "wx" }),
    remove: (id) => unlinkSync(path(id)),
    read: (id) => readFileSync(path(id)),
  };
}
