import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { slotsFixture } from "./slots-fixture.mjs";
import { sha256 } from "../io.mjs";

async function offsite(f, action, ...args) {
  const child = spawn(
    process.execPath,
    [
      resolve("ops/offsite-cli.mjs"),
      "--config",
      `${f.root}/deploy.json`,
      action,
      ...args,
    ],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${resolve("ops/testing/oss-hook.mjs")}`,
      },
    },
  );
  let output = "",
    error = "";
  child.stdout.on("data", (v) => (output += v));
  child.stderr.on("data", (v) => (error += v));
  const [code] = await once(child, "exit");
  return { code, output, error };
}
test("release requires fresh verified remote snapshot; upload failure preserves release and restart retries immutable bytes", async (t) => {
  const f = await slotsFixture(t);
  const priorPath = `${f.root}/control/uploads/prior.json`;
  const prior = JSON.parse(await readFile(priorPath, "utf8"));
  const baseline = JSON.parse(
    await readFile(`${f.root}/current/release.json`, "utf8"),
  ).commit;
  const release = (id) =>
    f.control(
      "release",
      "--id",
      id,
      "--candidate",
      "/candidate-artifact",
      "--baseline",
      baseline,
    );
  await rm(priorPath);
  let result = await release("missing");
  assert.notEqual(result.code, 0);
  assert.match(result.output, /OFFSITE_BACKUP_EXPIRED_OR_MISSING/);
  await writeFile(
    priorPath,
    JSON.stringify({
      ...prior,
      snapshotAt: new Date(Date.now() - 86400001).toISOString(),
    }),
  );
  result = await release("stale");
  assert.notEqual(result.code, 0);
  assert.equal((await fetch(f.origin + "/login")).status, 200);
  await writeFile(priorPath, JSON.stringify(prior));
  const remote = `${f.root}/control/synthetic-oss`;
  await mkdir(remote, { recursive: true });
  await writeFile(`${remote}/fault`, "offline");
  result = await release("offline-release");
  assert.equal(result.code, 0, result.output + result.error);
  assert.equal(JSON.parse(result.output).offsite.snapshot.phase, "pending");
  const jobPath = `${f.root}/control/uploads/offline-release.json`;
  const queued = JSON.parse(await readFile(jobPath, "utf8"));
  assert.equal(queued.phase, "pending");
  // Simulate power loss after final snapshot rename but before queue publication.
  await rm(jobPath);
  const original = await sha256(
    `${f.config.backupDir}/offline-release/data.tar.gz`,
  );
  result = await offsite(f, "upload");
  assert.notEqual(result.code, 0, result.output + result.error);
  let failed = JSON.parse(await readFile(jobPath, "utf8"));
  assert.equal(failed.phase, "failed");
  assert.equal(failed.failure, "OSS_OFFLINE");
  assert.ok(Date.parse(failed.nextAttemptAt) > Date.now());
  assert.equal((await fetch(f.origin + "/health/ready")).status, 200);
  await writeFile(
    jobPath,
    JSON.stringify({
      ...failed,
      attempts: 0,
      nextAttemptAt: new Date(0).toISOString(),
    }),
  );
  await writeFile(`${remote}/fault`, "slow-offline");
  await offsite(f, "upload");
  failed = JSON.parse(await readFile(jobPath, "utf8"));
  assert.ok(
    Date.parse(failed.nextAttemptAt) - Date.now() > 350000,
    "Backoff must start after the slow attempt fails",
  );
  await writeFile(
    jobPath,
    JSON.stringify({ ...failed, nextAttemptAt: new Date(0).toISOString() }),
  );
  await writeFile(`${remote}/fault`, "corrupt");
  result = await offsite(f, "upload");
  assert.notEqual(result.code, 0);
  failed = JSON.parse(await readFile(jobPath, "utf8"));
  assert.equal(failed.failure, "REMOTE_CHECKSUM_MISMATCH");
  await writeFile(
    jobPath,
    JSON.stringify({
      ...failed,
      attempts: 20,
      nextAttemptAt: new Date(0).toISOString(),
    }),
  );
  const retriedAt = Date.now();
  await offsite(f, "upload");
  failed = JSON.parse(await readFile(jobPath, "utf8"));
  assert.ok(
    Date.parse(failed.nextAttemptAt) - retriedAt >= 3590000 &&
      Date.parse(failed.nextAttemptAt) - retriedAt <= 3610000,
  );
  // A new CLI process resumes an interrupted uploading state using the same files.
  await writeFile(
    jobPath,
    JSON.stringify({ ...failed, phase: "uploading", nextAttemptAt: undefined }),
  );
  await rm(`${remote}/fault`);
  result = await offsite(f, "upload");
  assert.equal(result.code, 0, result.output + result.error);
  const verified = JSON.parse(await readFile(jobPath, "utf8"));
  assert.equal(verified.phase, "verified");
  assert.equal(
    await sha256(`${remote}/snapshots/offline-release/data.tar.gz`),
    original,
  );
  assert.equal(verified.snapshotAt, queued.snapshotAt);
  const queried = await f.control("status", "--id", "offline-release");
  assert.equal(JSON.parse(queried.output).offsite.snapshot.phase, "verified");
  await rm(priorPath);
  await writeFile(
    jobPath,
    JSON.stringify({
      ...verified,
      snapshotAt: new Date(Date.now() - 86400001).toISOString(),
      verifiedAt: new Date().toISOString(),
    }),
  );
  result = await offsite(f, "status");
  assert.equal(
    JSON.parse(result.output).fresh,
    false,
    "Upload time must not refresh old data",
  );
});

test("freshness is checked again after candidate preparation before maintenance", async (t) => {
  const f = await slotsFixture(t);
  const baseline = JSON.parse(
    await readFile(`${f.root}/current/release.json`, "utf8"),
  ).commit;
  const hook = `${f.root}/expire.mjs`;
  await writeFile(
    hook,
    `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1].endsWith('/control.mjs')) { const original=fs.rename;fs.rename=async function(from,to){const result=await original(from,to);
if(String(to).endsWith('/expires.json')) {const record=JSON.parse(await fs.readFile(to,'utf8'));if(record.target){const path=${JSON.stringify(f.root + "/control/uploads/prior.json")};const prior=JSON.parse(await fs.readFile(path,'utf8'));await fs.writeFile(path,JSON.stringify({...prior,snapshotAt:'2020-01-01T00:00:00Z'}));}}return result;};syncBuiltinESMExports();}`,
  );
  const result = await f.controlWith(
    ["--import", hook],
    "release",
    "--id",
    "expires",
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    baseline,
  );
  assert.notEqual(result.code, 0);
  assert.match(result.output, /OFFSITE_BACKUP_EXPIRED_OR_MISSING/);
  assert.equal((await fetch(f.origin + "/login")).status, 200);
  assert.equal(
    JSON.parse(await readFile(`${f.root}/current/release.json`, "utf8")).commit,
    baseline,
  );
});
