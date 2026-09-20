import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, readFile, readdir, access } from "node:fs/promises";
import { fixture, run } from "./fixture.mjs";

test("consistent backup, real maintenance, matched restore and corruption refusal", async (t) => {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  const backup = await f.control(
    "backup",
    "--id",
    "baseline",
    "--kind",
    "daily",
  );
  assert.equal(backup.code, 0, backup.error);
  assert.equal(JSON.parse(backup.output).phase, "completed");
  const snapshot = JSON.parse(
    await readFile(`${f.root}/backups/baseline/manifest.json`, "utf8"),
  );
  assert.match(snapshot.commit, /^[a-f0-9]{40}$/);
  await writeFile(
    `${f.root}/deploy.json`,
    JSON.stringify({ ...f.config, reserveBytes: Number.MAX_SAFE_INTEGER }),
  );
  const noSpace = await f.control(
    "restore",
    "--id",
    "no-space",
    "--snapshot",
    "baseline",
  );
  assert.notEqual(noSpace.code, 0);
  assert.match(noSpace.output, /INSUFFICIENT_DISK/);
  assert.equal(JSON.parse(noSpace.output).recovery, "not-needed");
  assert.ok(
    !(await readdir(`${f.root}/control`)).some((name) =>
      name.startsWith(".validated-"),
    ),
  );
  assert.equal((await fetch(`${f.origin}/login`)).status, 200);
  await writeFile(`${f.root}/deploy.json`, JSON.stringify(f.config));
  const newDiary = await f.request("/api/diaries", {
    title: "恢复时应移除",
    entries: [],
  });
  await writeFile(
    `${f.root}/data/attachments/${f.attachment}`,
    "changed bytes",
  );
  const restored = await f.control(
    "restore",
    "--id",
    "restore-baseline",
    "--snapshot",
    "baseline",
  );
  assert.equal(restored.code, 0, restored.error);
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
  assert.equal(
    await f.request(`/api/attachments/${f.attachment}`, undefined, true),
    "original attachment bytes",
  );
  assert.ok(
    !(await f.request("/api/diaries/mine")).some(
      (diary) => diary.id === newDiary.id,
    ),
  );
  await writeFile(
    `${f.root}/backups/baseline/data.tar.gz`,
    "corrupted archive",
  );
  const rejected = await f.control(
    "restore",
    "--id",
    "reject-corrupt",
    "--snapshot",
    "baseline",
  );
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.error + rejected.output, /SNAPSHOT_CHECKSUM/);
  assert.equal(
    await f.request(`/api/attachments/${f.attachment}`, undefined, true),
    "original attachment bytes",
  );
  run("systemctl", "stop", `${f.id}.service`);
});

test("a delayed duplicate returns the completed receipt after acquiring the lock", async (t) => {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  const hook = `${f.root}/pause-lock.mjs`;
  await writeFile(
    hook,
    `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.open;
fs.open = async function(path, ...args) {
  if (String(path).endsWith('/operation.lock')) {
    await fs.writeFile(${JSON.stringify(`${f.root}/paused`)}, 'ready');
    while (true) { try { await fs.access(${JSON.stringify(`${f.root}/resume`)}); break; } catch { await new Promise(r => setTimeout(r, 20)); } }
  }
  return original.call(this, path, ...args);
};
syncBuiltinESMExports();`,
  );
  const delayed = f.controlWith(
    ["--import", hook],
    "backup",
    "--id",
    "same-request",
  );
  for (let i = 0; i < 100; i++) {
    try {
      await access(`${f.root}/paused`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  await access(`${f.root}/paused`);
  const first = await f.control("backup", "--id", "same-request");
  assert.equal(first.code, 0, first.output + first.error);
  await writeFile(`${f.root}/resume`, "resume");
  const second = await delayed;
  assert.equal(second.code, 0, second.output + second.error);
  const firstReceipt = JSON.parse(first.output),
    secondReceipt = JSON.parse(second.output);
  const { backup: firstBackup, ...firstOperation } = firstReceipt;
  const { backup: secondBackup, ...secondOperation } = secondReceipt;
  assert.deepEqual(secondOperation, firstOperation);
  assert.equal(secondBackup.latestSnapshotId, firstBackup.latestSnapshotId);
  assert.equal(secondBackup.backup, "verified");
});

test("maintenance blocks every entrance and concurrent data operations cannot steal control", async (t) => {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  const first = f.control("backup", "--id", "owner");
  let maintenanceSeen = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await fetch(`${f.origin}/login`);
    if (response.status === 503) {
      maintenanceSeen = true;
      assert.equal(response.headers.get("retry-after"), "60");
      break;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.ok(
    maintenanceSeen,
    "Real proxy must enter maintenance before stopping data writes",
  );
  const competing = await f.control("backup", "--id", "contender");
  assert.notEqual(competing.code, 0);
  assert.match(competing.output, /OPERATION_BUSY/);
  for (const path of ["/api/diaries", "/public/example", "/mcp"])
    assert.equal(
      (await fetch(f.origin + path, { method: "POST" })).status,
      503,
    );
  const result = await first;
  assert.equal(result.code, 0, result.output + result.error);
  const status = await f.control("status", "--id", "owner");
  assert.equal(JSON.parse(status.output).phase, "completed");
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
});

test("invalid local bytes or insufficient disk do not produce usable snapshots and restart the original service", async (t) => {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  await writeFile(`${f.root}/data/attachments/${f.attachment}`, "wrong bytes");
  const failed = await f.control("backup", "--id", "invalid-bytes");
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /ATTACHMENT_(SIZE|BYTES)_MISMATCH/);
  assert.equal(JSON.parse(failed.output).recovery, "original-service-restored");
  assert.equal((await fetch(`${f.origin}/api/setup/status`)).status, 200);
  await assert.rejects(
    readFile(`${f.root}/backups/invalid-bytes/manifest.json`),
  );
  await writeFile(
    `${f.root}/data/attachments/${f.attachment}`,
    "original attachment bytes",
  );
  await writeFile(
    `${f.root}/deploy.json`,
    JSON.stringify({ ...f.config, reserveBytes: Number.MAX_SAFE_INTEGER }),
  );
  const full = await f.control("backup", "--id", "disk-full");
  assert.notEqual(full.code, 0);
  assert.match(full.output, /INSUFFICIENT_DISK/);
  assert.equal((await fetch(`${f.origin}/api/setup/status`)).status, 200);
  assert.equal(
    await f.request(`/api/attachments/${f.attachment}`, undefined, true),
    "original attachment bytes",
  );
});
