import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = resolve(app, "build");
const output = resolve(build, "server");
if (!output.startsWith(build + sep)) throw new Error("Invalid build output");
// Removed controllers must not survive as stale production artifacts.
rmSync(output, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.server.json"],
  {
    cwd: app,
    stdio: "inherit",
    windowsHide: true,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
