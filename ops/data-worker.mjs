import { resolve } from "node:path";
import { configuration } from "./host.mjs";
import { json, durable } from "./io.mjs";
import { backup, restore } from "./snapshots.mjs";

const config = await configuration(process.argv[2]);
const path = resolve(config.stateDir, "operations", `${process.argv[3]}.json`);
const operation = await json(path);
const result = ["backup", "release"].includes(operation.command)
  ? await backup(config, operation)
  : await restore(config, operation);
await durable(path, {
  ...operation,
  snapshotId: result.id,
  commit: result.commit,
  localBackup: "verified",
  phase: "data-ready",
});
