import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { slotsFixture } from "./slots-fixture.mjs";
import { run } from "./fixture.mjs";
import { sshFixture } from "./ssh-fixture.mjs";
import { sha256 } from "../io.mjs";
test("restricted SSH uploads a fixed candidate, rechecks status and refuses stale or arbitrary commands", async (t) => {
  const f = await slotsFixture(t),
    baseline = JSON.parse(
      await readFile(f.root + "/current/release.json", "utf8"),
    ).commit;
  f.config.incoming = f.root + "/incoming";
  f.config.repository = f.root + "/repository.git";
  f.config.automationEnabled = true;
  // The read-only checkout belongs to the runner, and PR HEAD is detached.
  // Use a fixture-owned remote with an explicit main; never trust all directories.
  const remote = f.root + "/remote.git";
  run(
    "git", "clone", "--bare", "--no-local",
    "--upload-pack=git -c safe.directory=/repository/.git upload-pack",
    "/repository", remote,
  );
  const candidate = JSON.parse(await readFile("/candidate-artifact/receipt.json", "utf8")).commit;
  run("git", "--git-dir", remote, "update-ref", "refs/heads/main", candidate);
  run("git", "clone", "--bare", remote, f.config.repository);
  await writeFile(
    f.root + "/control/runtime.json",
    JSON.stringify({
      commit: baseline,
      slot: "blue",
      artifact: f.config.artifact,
    }),
  );
  await writeFile(f.root + "/deploy.json", JSON.stringify(f.config));
  const ssh = await sshFixture(t, f);
  let result = await ssh("baseline");
  assert.equal(result.code, 0, result.output + result.error);
  assert.equal(JSON.parse(result.output).commit, baseline);
  result = await ssh("cat /etc/passwd");
  assert.notEqual(result.code, 0);
  assert.ok(!result.output.includes("root:"));
  const bundle = f.root + "/candidate.tar.gz";
  run(
    "tar",
    "-czf",
    bundle,
    "-C",
    "/candidate-artifact",
    "application.tar.gz",
    "receipt.json",
    "plan.json",
    "upgrade.json",
  );
  const digest = await sha256(bundle),
    id = "ci-release";
  result = await ssh(`upload ${id} ${digest}`, bundle);
  assert.equal(result.code, 0, result.output + result.error);
  result = await ssh(`status ${id}`);
  assert.equal(JSON.parse(result.output).phase, "uploaded");
  f.config.automationEnabled = false;
  await writeFile(f.root + "/deploy.json", JSON.stringify(f.config));
  result = await ssh(`release ${id} ${baseline}`);
  assert.equal(JSON.parse(result.output).error, "AUTOMATION_DISABLED");
  f.config.automationEnabled = true;
  await writeFile(f.root + "/deploy.json", JSON.stringify(f.config));
  result = await ssh(`release ${id} ${baseline}`);
  assert.equal(result.code, 0, result.output + result.error);
  let receipt;
  for (let n = 0; n < 240; n++) {
    result = await ssh(`status ${id}`);
    assert.equal(result.code, 0, result.output + result.error);
    receipt = JSON.parse(result.output);
    if (["completed", "failed"].includes(receipt.phase)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(receipt.phase, "completed", JSON.stringify(receipt));
  assert.equal(receipt.backup.snapshot.phase, "pending");
  result = await ssh(`release ${id} ${baseline}`);
  assert.equal(JSON.parse(result.output).phase, "completed");
  assert.equal(JSON.parse(result.output).actualCommit, receipt.actualCommit);
  // A persisted version pointer is not a completed operation receipt.
  const operationPath = f.root + `/control/operations/${id}.json`;
  const completed = JSON.parse(await readFile(operationPath, "utf8"));
  await writeFile(
    operationPath,
    JSON.stringify({
      ...completed,
      phase: "activating",
      actualCommit: undefined,
    }),
  );
  result = await ssh(`release ${id} ${baseline}`);
  assert.equal(JSON.parse(result.output).phase, "activating");
  await writeFile(
    operationPath,
    JSON.stringify({
      ...completed,
      phase: "failed",
      actualCommit: undefined,
      recovery: "preserved-new-data",
    }),
  );
  result = await ssh(`status ${id}`);
  assert.equal(JSON.parse(result.output).actualCommit, receipt.actualCommit);
  assert.equal(JSON.parse(result.output).snapshotCommit, baseline);
  assert.equal(JSON.parse(result.output).recovery, "preserved-new-data");
  await writeFile(operationPath, JSON.stringify(completed));
  const knownHosts = await readFile(f.root + "/known_hosts", "utf8");
  await writeFile(f.root + "/known_hosts", "");
  result = await ssh("baseline");
  assert.notEqual(result.code, 0, "An unknown SSH host must not be trusted");
  await writeFile(f.root + "/known_hosts", knownHosts);
  const old = f.root + "/old";
  await mkdir(old);
  await cp("/fixture-artifact/application.tar.gz", old + "/application.tar.gz");
  await cp("/fixture-artifact/receipt.json", old + "/receipt.json");
  await writeFile(old + "/plan.json", "{}");
  await writeFile(old + "/upgrade.json", "{}");
  const oldBundle = f.root + "/old.tar.gz";
  run(
    "tar",
    "-czf",
    oldBundle,
    "-C",
    old,
    "application.tar.gz",
    "receipt.json",
    "plan.json",
    "upgrade.json",
  );
  result = await ssh(`upload old ${await sha256(oldBundle)}`, oldBundle);
  assert.equal(result.code, 0, result.output + result.error);
  result = await ssh(`release old ${receipt.actualCommit}`);
  assert.notEqual(result.code, 0);
  assert.equal(
    JSON.parse((await ssh("baseline")).output).commit,
    receipt.actualCommit,
  );
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
});
