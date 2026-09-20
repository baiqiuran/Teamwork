import assert from "node:assert/strict";
import { configuration } from "./host.mjs";
import { localOnly, localStatus } from "./local-backups.mjs";
import { planRetention, applyRetention } from "./retention.mjs";
import { importLocalSnapshot, verifyDrill } from "./disaster.mjs";

const [flag, path, action, id, sourceFlag, source] = process.argv.slice(2);
assert.equal(flag, "--config");
const config = await configuration(path);
assert.ok(localOnly(config), "LOCAL_BACKUP_MODE_REQUIRED");
let result;
if (action === "status") result = await localStatus(config);
else if (action === "retention-plan") result = await planRetention(config);
else if (action === "retention-apply") result = await applyRetention(config);
else if (action === "import") {
  assert.equal(sourceFlag, "--source");
  assert.ok(source);
  result = await importLocalSnapshot(config, source, id);
} else if (action === "drill-verify")
  result = await verifyDrill(config, null, id);
else throw new Error("UNKNOWN_BACKUP_ACTION");
console.log(JSON.stringify(result));
