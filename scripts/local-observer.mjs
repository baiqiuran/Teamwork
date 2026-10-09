import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { processIdentity, writeJson } from "./local-process.mjs";
// The launcher passes only an internal record path and run id, never configuration values.
const path = process.env.DAILY_LOCAL_RUN_PATH;
if (path) {
  const latest = JSON.parse(readFileSync(resolve(path, "latest.json"), "utf8"));
  if (latest.runId === process.env.DAILY_LOCAL_RUN_ID)
    writeJson(resolve(path, "service.json"), {
      runId: latest.runId,
      pid: process.pid,
      processIdentity: processIdentity(process.pid),
      startedAt: new Date().toISOString(),
      entry: resolve(process.argv[1]),
    });
}
