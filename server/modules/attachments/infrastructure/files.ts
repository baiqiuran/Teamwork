import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  accessSync,
  constants,
  openSync,
  closeSync,
} from "node:fs";
import { resolve } from "node:path";
import type { FileStorage } from "../application/ports.ts";
export function assertStorageAccessible(directory: string) {
  accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
}
function storageErrorCode(error: unknown) {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,31}$/.test(error.code)
    ? error.code
    : "UNKNOWN";
}
export function localFiles(directory: string): FileStorage {
  mkdirSync(directory, { recursive: true });
  function path(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new Error("Invalid attachment storage key");
    return resolve(directory, id);
  }
  return {
    write: (id, bytes) => {
      const target = path(id);
      // Establish ownership before writing. EEXIST must never delete someone
      // else's file; close our descriptor before compensating on Windows.
      const descriptor = openSync(target, "wx");
      try {
        try {
          writeFileSync(descriptor, bytes);
        } finally {
          closeSync(descriptor);
        }
      } catch (error) {
        try {
          unlinkSync(target);
        } catch (cleanupError) {
          console.error("Attachment compensation failed:", {
            attachmentId: id,
            phase: "partial-write",
            writeCode: storageErrorCode(error),
            cleanupCode: storageErrorCode(cleanupError),
          });
          throw new AggregateError(
            [error, cleanupError],
            "Attachment write and cleanup failed",
          );
        }
        throw error;
      }
    },
    remove: (id) => {
      try {
        unlinkSync(path(id));
      } catch (error) {
        console.error("Attachment compensation failed:", {
          attachmentId: id,
          phase: "complete-write",
          cleanupCode: storageErrorCode(error),
        });
        throw error;
      }
    },
    read: (id) => readFileSync(path(id)),
  };
}
