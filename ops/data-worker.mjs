import { resolve } from "node:path";
import { configuration } from "./host.mjs";
import { json, durable } from "./io.mjs";
import { backup, restore } from "./snapshots.mjs";
import { slotConfig } from "./release.mjs";

const config = await configuration(process.argv[2]);
const path = resolve(config.stateDir, "operations", `${process.argv[3]}.json`);
const operation = await json(path);
const rollback = process.argv[4] === "rollback";
const result = rollback
  ? await restore(slotConfig(config, operation.target.oldSlot), {
      ...operation,
      command: "restore",
      id: operation.recoveryId,
      snapshot: operation.snapshotId,
    })
  : ["backup", "release"].includes(operation.command)
    ? await backup(config, operation)
    : await restore(config, operation);
await durable(path, {
  ...operation,
  snapshotId: result.id,
  commit: result.commit,
  localBackup: "verified",
  phase: rollback ? "rollback-data-ready" : "data-ready",
});
