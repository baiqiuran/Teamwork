import assert from "node:assert/strict";
import { open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { json, durable } from "./io.mjs";
import {
  configuration,
  exists,
  maintenance,
  stop,
  start,
  command,
} from "./host.mjs";
import { validate } from "./snapshots.mjs";

const args = process.argv.slice(2);
assert.equal(args.shift(), "--config");
const configPath = args.shift();
const config = await configuration(configPath);
const action = args.shift();
assert.ok(
  ["backup", "restore", "status"].includes(action),
  "Unknown operation",
);
const input = {};
while (args.length) {
  const key = args.shift();
  assert.ok(
    ["--id", "--kind", "--snapshot"].includes(key) &&
      args.length &&
      !input[key],
    "Invalid operation option",
  );
  input[key] = args.shift();
}
const id = input["--id"] ?? (action === "backup" ? randomUUID() : undefined);
assert.match(id ?? "", /^[a-zA-Z0-9_-]{1,80}$/);
if (input["--snapshot"])
  assert.match(input["--snapshot"], /^[a-zA-Z0-9_-]{1,80}$/);
const statePath = resolve(config.stateDir, "operations", `${id}.json`);
if (action === "status") {
  console.log(JSON.stringify(await json(statePath)));
} else {
  const kind = input["--kind"] ?? "manual";
  assert.ok(["daily", "pre-release", "manual"].includes(kind));
  if (action === "restore")
    assert.ok(input["--snapshot"], "Restore requires a snapshot id");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ action, kind, snapshot: input["--snapshot"] }))
    .digest("hex");
  if (await exists(statePath)) {
    const previous = await json(statePath);
    assert.equal(previous.fingerprint, fingerprint, "OPERATION_ID_CONFLICT");
    console.log(JSON.stringify(previous));
    if (previous.phase === "failed") process.exitCode = 1;
  } else {
    const lockPath = resolve(config.stateDir, "operation.lock");
    let lock,
      enteredMaintenance = false;
    let operation = {
      id,
      command: action,
      kind,
      snapshot: input["--snapshot"],
      fingerprint,
      phase: "preparing",
      createdAt: new Date().toISOString(),
      localBackup: "pending",
    };
    try {
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST") throw new Error("OPERATION_BUSY");
        throw error;
      }
      await lock.writeFile(JSON.stringify({ id, pid: process.pid }));
      await lock.sync();
      assert.ok(
        !(await exists(config.maintenance)) &&
          !(await exists(resolve(config.stateDir, "incident.json"))),
        "MAINTENANCE_OR_INCIDENT_ACTIVE",
      );
      await durable(statePath, operation);
      if (action === "restore") {
        const checked = await validate(
          config,
          resolve(config.backupDir, input["--snapshot"]),
        );
        await rm(checked, { recursive: true, force: true });
      }
      enteredMaintenance = true;
      await maintenance(config, true);
      operation = { ...operation, phase: "stopping" };
      await durable(statePath, operation);
      stop(config);
      operation = {
        ...operation,
        phase: "data-operation",
        stoppedAt: new Date().toISOString(),
      };
      await durable(statePath, operation);
      command(
        "/usr/bin/flock",
        "--nonblock",
        config.dataLock,
        process.execPath,
        fileURLToPath(new URL("./data-worker.mjs", import.meta.url)),
        resolve(configPath),
        id,
      );
      operation = await json(statePath);
      await start(config);
      await maintenance(config, false);
      enteredMaintenance = false;
      operation = {
        ...operation,
        phase: "completed",
        finishedAt: new Date().toISOString(),
      };
      await durable(statePath, operation);
      console.log(JSON.stringify(operation));
    } catch (error) {
      let recovery = "not-needed";
      if (enteredMaintenance) {
        if (action === "backup") {
          try {
            await start(config);
            await maintenance(config, false);
            recovery = "original-service-restored";
          } catch {
            recovery = "manual-intervention";
          }
        } else recovery = "manual-intervention";
        if (recovery === "manual-intervention") {
          await durable(config.maintenance, "maintenance\n", 0o644);
          await durable(resolve(config.stateDir, "incident.json"), {
            id,
            at: new Date().toISOString(),
            reason: "Operation failed while data was controlled",
          });
        }
      }
      const detail = error.stderr ? String(error.stderr) : error.message;
      operation = {
        ...operation,
        phase: "failed",
        failure: detail,
        recovery,
        finishedAt: new Date().toISOString(),
      };
      if (lock) await durable(statePath, operation);
      console.log(JSON.stringify(operation));
      process.exitCode = 1;
    } finally {
      if (lock) {
        await lock.close();
        await rm(lockPath);
      }
    }
  }
}
