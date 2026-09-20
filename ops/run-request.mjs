import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { configuration, exists } from "./host.mjs";
import { json, durable, sha256 } from "./io.mjs";
const [configPath, id] = process.argv.slice(2);
assert.match(id, /^[a-zA-Z0-9_-]{1,80}$/);
const config = await configuration(configPath);
const request = await json(resolve(config.stateDir, "requests", `${id}.json`));
try {
  if (request.candidate) {
    const index = request.args.indexOf("--candidate");
    assert.ok(index > 0);
    for (const [name, expected] of Object.entries(request.candidate))
      assert.equal(
        await sha256(resolve(request.args[index + 1], name)),
        expected,
        "QUEUED_CANDIDATE_CHANGED",
      );
  }
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./control.mjs", import.meta.url)), ...request.args],
    { stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
  if (
    process.exitCode &&
    !(await exists(resolve(config.stateDir, "operations", `${id}.json`)))
  )
    throw new Error("WORKER_FAILED_BEFORE_OPERATION_RECEIPT");
} catch (error) {
  await durable(resolve(config.stateDir, "requests", `${id}.result.json`), {
    id,
    phase: "failed",
    failure: error.message,
    finishedAt: new Date().toISOString(),
  });
  process.exitCode = 1;
}
