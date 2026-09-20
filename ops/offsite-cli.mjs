import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configuration, command } from "./host.mjs";
import { enqueue, upload, status } from "./offsite.mjs";
import { createStore } from "./oss.mjs";
import { planRetention, applyRetention } from "./retention.mjs";
import { pullSnapshot, verifyDrill } from "./disaster.mjs";
const [flag, path, action, id] = process.argv.slice(2);
assert.equal(flag, "--config");
assert.ok(
  [
    "enqueue",
    "upload",
    "status",
    "retention-plan",
    "retention-apply",
    "pull",
    "drill-verify",
  ].includes(action),
);
const config = await configuration(path, action === "drill-verify");
if (action === "status") console.log(JSON.stringify(await status(config)));
else if (!process.env.DAILY_OFFSITE_LOCKED) {
  try {
    process.stdout.write(
      command(
        "/usr/bin/flock",
        "--nonblock",
        resolve(config.stateDir, "offsite.gate"),
        "/usr/bin/env",
        "DAILY_OFFSITE_LOCKED=1",
        process.execPath,
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
      ),
    );
  } catch (error) {
    if (error.stdout) process.stdout.write(String(error.stdout));
    process.exitCode = 1;
  }
} else if (action === "enqueue") {
  await enqueue(config, id);
  console.log(JSON.stringify({ id, phase: "pending" }));
} else if (action === "pull" || action === "drill-verify") {
  console.log(
    JSON.stringify(
      await (action === "pull" ? pullSnapshot : verifyDrill)(
        config,
        await createStore(config),
        id,
      ),
    ),
  );
} else if (action === "retention-plan" || action === "retention-apply") {
  const store = await createStore(config);
  console.log(
    JSON.stringify(
      await (action === "retention-plan" ? planRetention : applyRetention)(
        config,
        store,
      ),
    ),
  );
} else {
  const results = await upload(config, await createStore(config));
  console.log(JSON.stringify({ results, ...(await status(config)) }));
  if (results.some((r) => r.phase === "failed")) process.exitCode = 1;
}
