import assert from "node:assert/strict";
import { open, readdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  configuration,
  command,
  exists,
  maintenance,
  stop,
  start,
} from "./host.mjs";
import { json, durable, syncPath } from "./io.mjs";
import { alive, processIdentity } from "./process-identity.mjs";
import {
  freeze,
  recoverBeforeOpen,
  verifyBaseline,
  verifyPublicBaseline,
} from "./recovery.mjs";

const [flag, configPath] = process.argv.slice(2);
assert.equal(flag, "--config");
let config = await configuration(resolve(configPath), false);
if (!process.env.DAILY_RECONCILE_LOCKED) {
  try {
    process.stdout.write(
      command(
        "/usr/bin/flock",
        "--nonblock",
        resolve(config.stateDir, "reconcile.gate"),
        "/usr/bin/env",
        "DAILY_RECONCILE_LOCKED=1",
        process.execPath,
        fileURLToPath(import.meta.url),
        "--config",
        resolve(configPath),
      ),
    );
  } catch (error) {
    if (error.stdout) process.stdout.write(String(error.stdout));
    process.exitCode = error.status ?? 1;
  }
} else {
  const lockPath = resolve(config.stateDir, "operation.lock");
  let lock,
    operation,
    originalState,
    uncertain = true;
  const id = `reconcile-${randomUUID()}`;
  try {
    if (await exists(lockPath)) {
      const previous = await json(lockPath);
      assert.ok(
        previous.id && previous.pid && previous.bootId && previous.startTime,
        "UNKNOWN_LOCK_IDENTITY",
      );
      if (await alive(previous)) {
        console.log(
          JSON.stringify({
            id: previous.id,
            phase: "running",
            reconciliation: "not-required",
          }),
        );
        process.exit(0);
      }
      // Reap a surviving data worker in the dead operation's systemd cgroup.
      const unit = `daily-flow-operation-${previous.id}.service`;
      if (
        command(
          "/bin/systemctl",
          "show",
          unit,
          "--property=LoadState",
          "--value",
        ).trim() !== "not-found"
      )
        command("/bin/systemctl", "stop", unit);
      await rename(lockPath, resolve(config.stateDir, `abandoned-${id}.json`));
    }
    uncertain = false;
    lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(JSON.stringify({ id, ...(await processIdentity()) }));
    await lock.sync();
    config = await configuration(resolve(configPath));
    const pending = [];
    for (const name of await readdir(resolve(config.stateDir, "operations"))) {
      if (!name.endsWith(".json")) continue;
      const value = await json(resolve(config.stateDir, "operations", name));
      assert.equal(name, `${value.id}.json`, "UNKNOWN_OPERATION_IDENTITY");
      if (!["completed", "failed"].includes(value.phase)) pending.push(value);
    }
    assert.ok(pending.length <= 1, "MULTIPLE_PENDING_OPERATIONS");
    operation = pending[0];
    if (operation)
      originalState = resolve(
        config.stateDir,
        "operations",
        `${operation.id}.json`,
      );
    await maintenance(config, true);
    for (const settings of Object.values(
      config.slots ?? { active: { unit: config.unit } },
    ))
      await stop({ ...config, unit: settings.unit });
    if (await exists(resolve(config.stateDir, "incident.json")))
      throw new Error("INCIDENT_REQUIRES_MANUAL_RESOLUTION");
    if (operation) {
      assert.ok(
        [
          "backup",
          "release",
          "restore",
          "resolve-incident",
          "inspect",
        ].includes(operation.command),
        "UNKNOWN_OPERATION_COMMAND",
      );
      assert.ok(
        !operation.mayHaveOpenedAt && !operation.recoveryOpeningAt,
        "OPEN_BOUNDARY_REQUIRES_MANUAL_RESOLUTION",
      );
      if (
        operation.command === "release" &&
        ["data-ready", "activating"].includes(operation.phase)
      ) {
        assert.equal(
          operation.localBackup,
          "verified",
          "VERIFIED_SNAPSHOT_REQUIRED",
        );
        operation = await recoverBeforeOpen(configPath, config, operation);
      } else if (
        ["preparing", "stopping", "data-operation", "data-ready"].includes(
          operation.phase,
        ) &&
        ["backup", "release"].includes(operation.command)
      ) {
        // Only a copy may have occurred. Keep current bytes and never rerun migration.
        const actual = await json(resolve(config.current, "release.json"));
        if (operation.command === "release")
          assert.equal(actual.commit, operation.baseline, "BASELINE_CHANGED");
        await start(config);
        await verifyBaseline(config, actual.commit);
        await maintenance(config, false);
        await verifyPublicBaseline(config, actual.commit);
        operation.recovery = "original-service-restored";
      } else throw new Error("UNKNOWN_OR_INTERRUPTED_DATA_RESTORE");
      operation = {
        ...operation,
        phase: "failed",
        failure: "WORKER_INTERRUPTED",
        reconciledAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      await durable(originalState, operation);
      console.log(JSON.stringify(operation));
    } else {
      const runtime = await json(resolve(config.stateDir, "runtime.json"));
      assert.equal(
        (await json(resolve(config.current, "release.json"))).commit,
        runtime.commit,
        "RUNTIME_IDENTITY_MISMATCH",
      );
      await start(config);
      await verifyBaseline(config, runtime.commit);
      await maintenance(config, false);
      await verifyPublicBaseline(config, runtime.commit);
      const result = {
        id,
        phase: "completed",
        bootReconciledAt: new Date().toISOString(),
        actualCommit: runtime.commit,
        slot: config.activeSlot,
      };
      await durable(resolve(config.stateDir, "boot.json"), result);
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    if (lock || uncertain) {
      await freeze(config, operation ?? { id }, error.message, true);
      if (originalState && operation) {
        const saved = await json(originalState);
        await durable(originalState, {
          ...saved,
          interruptedPhase: saved.phase,
          phase: "failed",
          recovery: "manual-intervention",
          failure: error.message,
          reconciledAt: new Date().toISOString(),
        });
      }
      const result = {
        id,
        phase: "failed",
        recovery: "manual-intervention",
        reason: error.message,
        operation: operation?.id,
      };
      await durable(resolve(config.stateDir, "reconciliation.json"), result);
      console.log(JSON.stringify(result));
    } else
      console.log(
        JSON.stringify({ id, phase: "failed", reason: error.message }),
      );
    process.exitCode = 1;
  } finally {
    if (lock) {
      await lock.close();
      await rm(lockPath);
      await syncPath(config.stateDir);
    }
  }
}
