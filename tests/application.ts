import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Exercise the same compiled backend that production runs, including decorators.
const backend: typeof import("../server/app.ts") = await import(
  pathToFileURL(resolve("build/server/app.js")).href
);
export const createUnconfiguredApp = backend.createApp;
// Test-only master, outside the repository, stable across fixture restarts.
const directory = mkdtempSync(join(tmpdir(), "daily-ai-master-test-"));
const masterFile = join(directory, "master.key");
writeFileSync(masterFile, `${randomBytes(32).toString("hex")}\n`, {
  mode: 0o600,
});
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
export const createApp: typeof backend.createApp = (options) =>
  backend.createApp({ aiKeyMasterFile: masterFile, ...options });
