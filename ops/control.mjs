import assert from "node:assert/strict";
import { open, rm, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { intent } from "./intent.mjs";
import { requireFresh, report } from "./offsite.mjs";
import { processIdentity } from "./process-identity.mjs";
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
import { prepare, activate, externalProbe } from "./release.mjs";
import {
  freeze,
  recoverBeforeOpen,
  observe,
  resolveIncident,
} from "./recovery.mjs";

const args = process.argv.slice(2);
assert.equal(args.shift(), "--config");
const configPath = args.shift();
const action = args.shift();
let config = await configuration(configPath, action !== "status");
assert.ok(
  [
    "backup",
    "restore",
    "release",
    "status",
    "inspect",
    "resolve-incident",
  ].includes(action),
  "Unknown operation",
);
const input = {};
while (args.length) {
  const key = args.shift();
  assert.ok(
    [
      "--id",
      "--kind",
      "--snapshot",
      "--candidate",
      "--baseline",
      "--incident",
      "--expected-commit",
      "--note",
    ].includes(key) &&
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
  if (await exists(statePath))
    console.log(JSON.stringify(await report(config, await json(statePath))));
  else if (
    await exists(resolve(config.stateDir, "requests", `${id}.result.json`))
  )
    console.log(
      JSON.stringify(
        await json(resolve(config.stateDir, "requests", `${id}.result.json`)),
      ),
    );
  else {
    const request = await json(
      resolve(config.stateDir, "requests", `${id}.json`),
    );
    const active = command(
      "/bin/systemctl",
      "show",
      request.unit,
      "--property=ActiveState",
      "--value",
    ).trim();
    console.log(
      JSON.stringify({
        id,
        phase: ["active", "activating"].includes(active)
          ? "accepted"
          : "unknown",
        unit: request.unit,
        ...(["active", "activating"].includes(active)
          ? {}
          : { reason: "WORKER_STATE_REQUIRES_RECONCILIATION" }),
      }),
    );
  }
} else {
  const kind =
    action === "release" ? "pre-release" : (input["--kind"] ?? "manual");
  assert.ok(["daily", "pre-release", "manual"].includes(kind));
  if (action === "restore")
    assert.ok(input["--snapshot"], "Restore requires a snapshot id");
  if (action === "release") {
    assert.match(input["--baseline"] ?? "", /^[a-f0-9]{40}$/);
    assert.ok(input["--candidate"], "Candidate directory required");
    input["--candidate"] = resolve(input["--candidate"]);
  }
  const { fingerprint } = await intent(action, input);
  if (await exists(statePath)) {
    const previous = await json(statePath);
    assert.equal(previous.fingerprint, fingerprint, "OPERATION_ID_CONFLICT");
    console.log(JSON.stringify(await report(config, previous)));
    if (previous.phase === "failed") process.exitCode = 1;
  } else {
    const lockPath = resolve(config.stateDir, "operation.lock");
    let lock,
      enteredMaintenance = false,
      ownsRecord = false;
    let operation = {
      id,
      command: action,
      kind,
      snapshot: input["--snapshot"],
      candidate: input["--candidate"],
      baseline: input["--baseline"],
      incident: input["--incident"],
      expectedCommit: input["--expected-commit"],
      note: input["--note"],
      fingerprint,
      phase: "preparing",
      createdAt: new Date().toISOString(),
      localBackup: "pending",
    };
    execution: {
      try {
        try {
          lock = await open(lockPath, "wx", 0o600);
        } catch (error) {
          if (error.code === "EEXIST") throw new Error("OPERATION_BUSY");
          throw error;
        }
        await lock.writeFile(
          JSON.stringify({ id, ...(await processIdentity()) }),
        );
        await lock.sync();
        config = await configuration(configPath);
        const acceptedPath = resolve(config.stateDir, "requests", `${id}.json`);
        const currentIntent = await intent(action, input);
        assert.equal(
          currentIntent.fingerprint,
          fingerprint,
          "CANDIDATE_CHANGED_WHILE_WAITING",
        );
        if (await exists(acceptedPath))
          assert.equal(
            (await json(acceptedPath)).fingerprint,
            currentIntent.fingerprint,
            "ACCEPTED_REQUEST_CHANGED",
          );
        for (const name of await readdir(
          resolve(config.stateDir, "operations"),
        )) {
          if (!name.endsWith(".json") || name === `${id}.json`) continue;
          const previous = await json(
            resolve(config.stateDir, "operations", name),
          );
          assert.ok(
            ["completed", "failed"].includes(previous.phase),
            "PENDING_OPERATION_RECONCILIATION",
          );
        }
        // Another process may have completed this ID between our first lookup
        // and acquiring the lock. Never overwrite its receipt, even on conflict.
        if (await exists(statePath)) {
          const previous = await json(statePath);
          assert.equal(
            previous.fingerprint,
            fingerprint,
            "OPERATION_ID_CONFLICT",
          );
          console.log(JSON.stringify(await report(config, previous)));
          if (previous.phase === "failed") process.exitCode = 1;
          break execution;
        }
        if (!["inspect", "resolve-incident"].includes(action))
          assert.ok(
            !(await exists(config.maintenance)) &&
              !(await exists(resolve(config.stateDir, "incident.json"))),
            "MAINTENANCE_OR_INCIDENT_ACTIVE",
          );
        ownsRecord = true;
        await durable(statePath, operation);
        if (action === "inspect" || action === "resolve-incident") {
          if (action === "inspect") {
            const current = await json(
              resolve(config.stateDir, "runtime.json"),
            );
            operation.inspection = await observe(
              config,
              operation,
              current.commit,
            );
            if (!operation.inspection.healthy)
              throw new Error("INSPECTION_FAILED");
          } else operation = await resolveIncident(config, operation);
          operation = {
            ...operation,
            phase: "completed",
            finishedAt: new Date().toISOString(),
          };
          await durable(statePath, operation);
          console.log(JSON.stringify(operation));
          break execution;
        }
        if (action === "release") {
          operation.backup = await requireFresh(config);
          operation.target = await prepare(config, operation);
          await durable(statePath, operation);
        }
        if (action === "restore") {
          const checked = await validate(
            config,
            resolve(config.backupDir, input["--snapshot"]),
          );
          await rm(checked, { recursive: true, force: true });
        }
        if (action === "release") operation.backup = await requireFresh(config);
        enteredMaintenance = true;
        await maintenance(config, true);
        operation = {
          ...operation,
          phase: "stopping",
          maintenanceAt: new Date().toISOString(),
        };
        await durable(statePath, operation);
        await stop(config);
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
        if (action === "release") {
          operation = { ...operation, phase: "activating" };
          await durable(statePath, operation);
          await activate(config, operation);
          operation = {
            ...operation,
            phase: "may-be-open",
            mayHaveOpenedAt: new Date().toISOString(),
          };
          // This marker deliberately precedes opening. A lost acknowledgement
          // must never cause a later worker to overwrite newly accepted writes.
          await durable(statePath, operation);
        } else await start(config);
        await maintenance(config, false);
        if (action === "release") {
          const observed = await externalProbe(config, operation.target.commit);
          operation.actualCommit = observed.version;
        }
        enteredMaintenance = false;
        operation = await report(config, operation);
        operation = {
          ...operation,
          phase: "completed",
          finishedAt: new Date().toISOString(),
          ...(action === "release"
            ? {
                actualCommit: operation.actualCommit,
                slot: operation.target.slot,
                maintenanceMilliseconds:
                  Date.now() - Date.parse(operation.maintenanceAt),
                maintenanceBudgetMilliseconds: 600000,
              }
            : {}),
        };
        await durable(statePath, operation);
        console.log(JSON.stringify(operation));
      } catch (error) {
        let recovery = "not-needed";
        if (action === "release" && enteredMaintenance) {
          if (operation.mayHaveOpenedAt) {
            recovery = "preserved-new-data";
            await freeze(
              config,
              operation,
              "POST_OPEN_VERIFICATION_FAILED",
              false,
            );
            config = await configuration(configPath);
            operation.inspection = await observe(
              config,
              operation,
              operation.target.commit,
            );
          } else {
            try {
              operation = await recoverBeforeOpen(
                configPath,
                config,
                operation,
              );
              recovery = operation.recovery;
            } catch (restoreError) {
              operation = { ...operation, ...(await json(statePath)) };
              recovery = "manual-intervention";
              operation.recoveryFailure = restoreError.stderr
                ? String(restoreError.stderr)
                : restoreError.message;
              await freeze(config, operation, "BASELINE_RECOVERY_FAILED", true);
            }
          }
        } else if (action === "resolve-incident" && ownsRecord) {
          operation = { ...operation, ...(await json(statePath)) };
          recovery = "manual-intervention";
          if (operation.mayHaveOpenedAt)
            await freeze(config, operation, "MANUAL_RESOLUTION_FAILED", true);
        } else if (enteredMaintenance) {
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
        if (ownsRecord) await durable(statePath, operation);
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
}
