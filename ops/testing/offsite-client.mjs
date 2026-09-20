import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
export async function offsite(config, action, ...args) {
  const child = spawn(
    process.execPath,
    [resolve("ops/offsite-cli.mjs"), "--config", config, action, ...args],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${resolve("ops/testing/oss-hook.mjs")}`,
      },
    },
  );
  let output = "",
    error = "";
  child.stdout.on("data", (v) => (output += v));
  child.stderr.on("data", (v) => (error += v));
  const [code] = await once(child, "exit");
  return { code, output, error };
}
