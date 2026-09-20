import assert from "node:assert/strict";
import { resolve } from "node:path";
import { json } from "./io.mjs";
import { bootId } from "./process-identity.mjs";
const [flag, configPath, slotFlag, slot] = process.argv.slice(2);
assert.equal(flag, "--config");
assert.equal(slotFlag, "--slot");
assert.ok(["blue", "green"].includes(slot));
const config = await json(configPath);
const permit = await json(resolve(config.stateDir, "owner.json"));
assert.equal(permit.bootId, await bootId(), "BOOT_RECONCILIATION_REQUIRED");
assert.equal(permit.slot, slot, "SLOT_DOES_NOT_OWN_DATA");
assert.equal(
  (await json(resolve(config.slots[slot].link, "release.json"))).commit,
  permit.commit,
  "OWNER_CODE_MISMATCH",
);
