import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, access, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { run } from "./fixture.mjs";
import { slotsFixture } from "./slots-fixture.mjs";

async function release(f, id, hook) {
  const baseline = JSON.parse(
    await readFile(`${f.root}/current/release.json`, "utf8"),
  ).commit;
  return f.controlWith(
    hook ? ["--import", hook] : [],
    "release",
    "--id",
    id,
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    baseline,
  );
}
test("failed proxy reload restores the paired baseline before reopening", async (t) => {
  const f = await slotsFixture(t);
  const hook = `${f.root}/proxy-fault.mjs`;
  await writeFile(
    hook,
    `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
const original=cp.execFileSync; let failed=false;
cp.execFileSync=function(name,args,...rest) { if(!failed && name==='/bin/systemctl' && args.join(' ')==='reload nginx') { failed=true; throw new Error('INJECTED_PROXY_RELOAD_FAILURE'); } return original.call(this,name,args,...rest); }; syncBuiltinESMExports();`,
  );
  const result = await release(f, "proxy-failure", hook);
  assert.notEqual(result.code, 0);
  const outcome = JSON.parse(result.output);
  assert.equal(
    outcome.recovery,
    "baseline-restored",
    result.output + result.error,
  );
  assert.equal((await fetch(f.origin + "/login")).status, 200);
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
  assert.equal(
    await f.request(`/api/attachments/${f.attachment}`, undefined, true),
    "original attachment bytes",
  );
  await assert.rejects(access(`${f.root}/control/incident.json`));
});

test("startup failure after touching data restores old code, diary and attachment together", async (t) => {
  const f = await slotsFixture(t);
  const hook = `${f.root}/migration-fault.mjs`;
  const failingMain = `import { DatabaseSync } from 'node:sqlite'; import { writeFileSync } from 'node:fs'; import { dirname, resolve } from 'node:path';
const db = new DatabaseSync(process.env.DAILY_DATABASE_PATH);
db.prepare('UPDATE diaries SET draft = ?').run(JSON.stringify({ title: 'injected bad migration', entries: [] })); db.close();
writeFileSync(resolve(dirname(process.env.DAILY_DATABASE_PATH), 'attachments', ${JSON.stringify(f.attachment)}), 'changed during failed startup');
throw new Error('INJECTED_STARTUP_FAILURE');`;
  await writeFile(
    hook,
    `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
const original=fs.rename; let failed=false;
fs.rename=async function(from,to) { const result=await original.call(this,from,to); if(!failed && to===${JSON.stringify(f.root + "/current")}) {
failed=true; const release=await fs.readlink(to); await fs.writeFile(release+'/build/server/main.js', ${JSON.stringify(failingMain)}); } return result; }; syncBuiltinESMExports();`,
  );
  const result = await release(f, "startup-failure", hook);
  assert.notEqual(result.code, 0);
  assert.equal(
    JSON.parse(result.output).recovery,
    "baseline-restored",
    result.output + result.error,
  );
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).draft.title,
    "必须保留的日报",
  );
  assert.equal(
    await f.request(`/api/attachments/${f.attachment}`, undefined, true),
    "original attachment bytes",
  );
});

test("failed recovery stays in maintenance and freezes later releases", async (t) => {
  const f = await slotsFixture(t);
  const hook = `${f.root}/recovery-fault.mjs`;
  await writeFile(
    hook,
    `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'; const original=cp.execFileSync;
cp.execFileSync=function(name,args,...rest) { if(name==='/bin/systemctl' && args.join(' ')==='reload nginx') throw new Error('INJECTED_PROXY');
if(name==='/usr/bin/flock' && args.includes('rollback')) throw new Error('INJECTED_RECOVERY_FAILURE'); return original.call(this,name,args,...rest); }; syncBuiltinESMExports();`,
  );
  const result = await release(f, "broken-recovery", hook);
  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.output).recovery, "manual-intervention");
  assert.equal((await fetch(f.origin + "/login")).status, 503);
  await access(`${f.root}/control/incident.json`);
  const next = await release(f, "must-stay-frozen");
  assert.notEqual(next.code, 0);
  assert.match(next.output, /MAINTENANCE_OR_INCIDENT_ACTIVE/);
  assert.equal(
    await readFile(`${f.root}/data/attachments/${f.attachment}`, "utf8"),
    "original attachment bytes",
  );
});

test("startup budget expiration restores the matching baseline", async (t) => {
  const f = await slotsFixture(t);
  const hook = `${f.root}/timeout-fault.mjs`;
  await writeFile(
    hook,
    `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
const original=cp.execFileSync, now=Date.now; let offset=0; Date.now=()=>now()+offset;
cp.execFileSync=function(name,args,...rest) { const result=original.call(this,name,args,...rest);
if(name==='/bin/systemctl' && args[0]==='start' && args[1]===${JSON.stringify(f.config.slots.green.unit)}) offset=120001;
return result; }; syncBuiltinESMExports();`,
  );
  const result = await release(f, "startup-budget", hook);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /STARTUP_TIMEOUT/);
  assert.equal(JSON.parse(result.output).recovery, "baseline-restored");
  assert.equal(
    await f.request(`/api/attachments/${f.attachment}`, undefined, true),
    "original attachment bytes",
  );
});

test("failure at the durable opening marker never restores data even while ingress is still closed", async (t) => {
  const f = await slotsFixture(t);
  const hook = `${f.root}/marker-fault.mjs`;
  await writeFile(
    hook,
    `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module'; const original=fs.rename; let failed=false;
fs.rename=async function(from,to) { const result=await original.call(this,from,to);
if(!failed && to===${JSON.stringify(f.root + "/control/operations/open-marker.json")} && JSON.parse(await fs.readFile(to,'utf8')).phase==='may-be-open') { failed=true; throw new Error('INJECTED_MARKER_ACK_LOSS'); }
return result; }; syncBuiltinESMExports();`,
  );
  const result = await release(f, "open-marker", hook);
  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.output).recovery, "preserved-new-data");
  assert.ok(JSON.parse(result.output).mayHaveOpenedAt);
  assert.equal((await fetch(f.origin + "/login")).status, 503);
  assert.ok(
    !(await readdir(f.root)).some((name) =>
      name.startsWith("data.before-restore"),
    ),
  );
  assert.equal(
    JSON.parse(await readFile(`${f.root}/control/runtime.json`, "utf8")).slot,
    "green",
  );
});

test("explicit data health failure closes ingress immediately and preserves bytes", async (t) => {
  const f = await slotsFixture(t);
  const result = await release(f, "healthy-release");
  assert.equal(result.code, 0, result.output + result.error);
  run("chmod", "000", `${f.root}/data/attachments`);
  try {
    const status = await f.control("inspect", "--id", "data-health-failed");
    assert.notEqual(status.code, 0);
    assert.equal(
      JSON.parse(status.output).inspection.reason,
      "DATA_HEALTH_FAILED",
    );
    assert.equal((await fetch(f.origin + "/login")).status, 503);
    assert.equal(
      await readFile(`${f.root}/data/attachments/${f.attachment}`, "utf8"),
      "original attachment bytes",
    );
  } finally {
    run("chmod", "755", `${f.root}/data/attachments`);
  }
});

test("post-open failure preserves newly submitted diary and attachment; only explicit resolution unfreezes", async (t) => {
  const f = await slotsFixture(t);
  const hook = `${f.root}/opened-fault.mjs`;
  await writeFile(
    hook,
    `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
const original=fs.rm; let paused=false; fs.rm=async function(path,...args) { const result=await original.call(this,path,...args);
if(!paused && path===${JSON.stringify(f.root + "/maintenance")}) { paused=true; await fs.writeFile(${JSON.stringify(f.root + "/opened")}, 'ready');
while(true) { try { await fs.access(${JSON.stringify(f.root + "/continue")}); break; } catch { await new Promise(r=>setTimeout(r,20)); } } } return result; }; syncBuiltinESMExports();
const fetchOriginal=globalThis.fetch; globalThis.fetch=(url,options)=> String(url)===${JSON.stringify(f.origin + "/health/ready")} ? Promise.resolve(new Response('{}',{status:503})) : fetchOriginal(url,options);`,
  );
  const operation = release(f, "post-open", hook);
  t.after(async () => {
    await writeFile(`${f.root}/continue`, "continue");
    await operation;
  });
  for (let i = 0; i < 1000; i++) {
    try {
      await access(`${f.root}/opened`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  await access(`${f.root}/opened`);
  const entryId = randomUUID();
  let diary = await f.request("/api/diaries", {
    title: "开放后的新日报",
    entries: [{ id: entryId, body: "已经接受的新工作" }],
  });
  diary = await f.request(
    `/api/diaries/${diary.id}/entries/${entryId}/attachments`,
    {
      version: diary.version,
      requestId: randomUUID(),
      name: "new.txt",
      base64: Buffer.from("new bytes must survive").toString("base64"),
    },
  );
  diary = await f.request(`/api/diaries/${diary.id}/submit`, {
    version: diary.version,
    requestId: randomUUID(),
  });
  const attachment = diary.published.entries[0].attachments[0].id;
  await writeFile(`${f.root}/continue`, "continue");
  const result = await operation;
  assert.notEqual(result.code, 0);
  assert.equal(
    JSON.parse(result.output).recovery,
    "preserved-new-data",
    result.output + result.error,
  );
  assert.equal(
    (await f.request(`/api/diaries/${diary.id}`)).published.entries[0].body,
    "已经接受的新工作",
  );
  assert.equal(
    await f.request(`/api/attachments/${attachment}`, undefined, true),
    "new bytes must survive",
  );
  assert.ok(
    !(await readdir(f.root)).some((name) =>
      name.startsWith("data.before-restore"),
    ),
  );
  const incident = JSON.parse(
    await readFile(`${f.root}/control/incident.json`, "utf8"),
  );
  const target = JSON.parse(
    await readFile(`${f.root}/control/runtime.json`, "utf8"),
  ).commit;
  const unfreeze = await f.control(
    "resolve-incident",
    "--id",
    "verified-manually",
    "--incident",
    incident.id,
    "--expected-commit",
    target,
    "--note",
    "隔离演练已验证新数据及公开入口",
  );
  assert.equal(unfreeze.code, 0, unfreeze.output + unfreeze.error);
  await assert.rejects(access(`${f.root}/control/incident.json`));
  // Availability failure must meet both the count and elapsed-time threshold.
  run("systemctl", "stop", f.config.slots.green.unit);
  const first = await f.control("inspect", "--id", "offline-one");
  assert.equal(JSON.parse(first.output).inspection.maintenance, false);
  const clock = `${f.root}/later-clock.mjs`;
  await writeFile(
    clock,
    "const now = Date.now; Date.now = () => now() + 61000;",
  );
  const second = await f.controlWith(
    ["--import", clock],
    "inspect",
    "--id",
    "offline-two",
  );
  assert.equal(JSON.parse(second.output).inspection.maintenance, false);
  const third = await f.controlWith(
    ["--import", clock],
    "inspect",
    "--id",
    "offline-three",
  );
  assert.equal(JSON.parse(third.output).inspection.maintenance, true);
  assert.equal((await fetch(f.origin + "/login")).status, 503);
  assert.equal(
    await readFile(`${f.root}/data/attachments/${attachment}`, "utf8"),
    "new bytes must survive",
  );
});
