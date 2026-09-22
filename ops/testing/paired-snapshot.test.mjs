import assert from "node:assert/strict";
import { test } from "node:test";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { fixture, run } from "./fixture.mjs";

const V2 = "b".repeat(40),
  V3 = "c".repeat(40);

/**
 * Stands in for the release step ticket 05 has to build: put another version on
 * disk beside the archive that produced it, repoint the current link and record
 * what is now serving. The invariant the snapshot code depends on is preserved
 * here and only here: the artifact named by the runtime identity is the code
 * that answers requests.
 */
async function serve(f, commit) {
  const release = `${f.config.releases}/${commit.slice(0, 8)}`;
  run("cp", "-a", `${f.config.releases}/initial`, release);
  const manifest = JSON.parse(
    await readFile(`${release}/release.json`, "utf8"),
  );
  await writeFile(
    `${release}/release.json`,
    JSON.stringify({ ...manifest, commit }) + "\n",
  );
  run(
    "sh",
    "-c",
    // Fixture-owned paths only. Relative member names matter: the restore side
    // reads `release.json` out of the archive by that exact name.
    `cd ${release} && tar -czf application.tar.gz build dist node_modules package.json package-lock.json release.json`,
  );
  await unlink(f.config.current);
  await symlink(release, `${f.config.current}.new`);
  await rename(`${f.config.current}.new`, f.config.current);
  await writeFile(
    `${f.config.stateDir}/runtime.json`,
    JSON.stringify({ commit, artifact: `${release}/application.tar.gz` }),
  );
  run("systemctl", "restart", f.config.unit);
  for (let attempt = 0; attempt < 200; attempt++) {
    const ready = await fetch(`${f.origin}/health/ready`).catch(() => null);
    if (ready?.status === 200 && (await ready.json()).version === commit)
      return;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.fail(
    `the single instance never reported ${commit}; ActiveState=` +
      run(
        "systemctl",
        "show",
        f.config.unit,
        "--property=ActiveState",
        "--value",
      ).trim(),
  );
}

const servingCommit = async (f) =>
  (await (await fetch(`${f.origin}/health/ready`)).json()).version;

test("each pre-release snapshot carries the code and the data of its own instant", async (t) => {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  const v1 = JSON.parse(
    await readFile(`${f.root}/current/release.json`, "utf8"),
  ).commit;
  assert.equal(await servingCommit(f), v1);
  const beforeSecond = await f.control(
    "backup",
    "--id",
    "before-second",
    "--kind",
    "pre-release",
  );
  assert.equal(beforeSecond.code, 0, beforeSecond.output + beforeSecond.error);
  // Data and code are taken in one stop window, so the snapshot's own stamp is
  // the moment writing stopped rather than a later reconstruction.
  const stoppedAt = JSON.parse(beforeSecond.output).stoppedAt;
  const firstPoint = JSON.parse(
    await readFile(`${f.config.backupDir}/before-second/manifest.json`, "utf8"),
  );
  assert.equal(firstPoint.snapshotAt, stoppedAt);

  await serve(f, V2);
  const secondEraDiary = await f.request("/api/diaries", {
    title: "第二版期间提交",
    entries: [],
  });
  const beforeThird = await f.control(
    "backup",
    "--id",
    "before-third",
    "--kind",
    "pre-release",
  );
  assert.equal(beforeThird.code, 0, beforeThird.output + beforeThird.error);
  await serve(f, V3);
  assert.equal(await servingCommit(f), V3);
  const thirdEraDiary = await f.request("/api/diaries", {
    title: "第三版期间提交",
    entries: [],
  });

  // One snapshot, no other search: the older code comes back with it.
  const toSecond = await f.control(
    "restore",
    "--id",
    "back-to-second",
    "--snapshot",
    "before-third",
  );
  assert.equal(toSecond.code, 0, toSecond.output + toSecond.error);
  assert.equal(
    await servingCommit(f),
    V2,
    "restoring must not leave the newer program on older data",
  );
  const mine = (await f.request("/api/diaries/mine")).map((diary) => diary.id);
  assert.ok(
    mine.includes(secondEraDiary.id),
    "the diary of that instant must survive",
  );
  assert.ok(!mine.includes(thirdEraDiary.id), "the newer diary must be gone");

  const toFirst = await f.control(
    "restore",
    "--id",
    "back-to-first",
    "--snapshot",
    "before-second",
  );
  assert.equal(toFirst.code, 0, toFirst.output + toFirst.error);
  assert.equal(await servingCommit(f), v1);
  const after = (await f.request("/api/diaries/mine")).map((diary) => diary.id);
  assert.ok(!after.includes(secondEraDiary.id));
  assert.ok(!after.includes(thirdEraDiary.id));
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
  // The restored state has to be a base the next release can snapshot from,
  // which only holds if the restore also rewrote the runtime identity.
  const fromRestored = await f.control(
    "backup",
    "--id",
    "after-restores",
    "--kind",
    "daily",
  );
  assert.equal(
    fromRestored.code,
    0,
    fromRestored.output + fromRestored.error,
  );
});

test("code patched in place without a new artifact is refused as a recovery point", async (t) => {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  // The label still matches its archive; only the served bytes moved. A
  // snapshot taken now would carry code that never served.
  const entry = `${f.root}/current/build/server/main.js`;
  await writeFile(entry, (await readFile(entry, "utf8")) + "// hotfixed\n");
  const result = await f.control(
    "backup",
    "--id",
    "hotfixed",
    "--kind",
    "pre-release",
  );
  assert.notEqual(result.code, 0);
  assert.match(result.output + result.error, /SERVED_CODE_MISMATCH/);
  assert.ok(
    !(await readdir(f.config.backupDir)).includes("hotfixed"),
    "a refused backup must not remain as a recovery point",
  );
});

test("a served identity its archive cannot confirm is refused as a recovery point", async (t) => {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  const manifest = JSON.parse(
    await readFile(`${f.root}/current/release.json`, "utf8"),
  );
  await writeFile(
    `${f.root}/current/release.json`,
    JSON.stringify({ ...manifest, commit: "d".repeat(40) }) + "\n",
  );
  const result = await f.control("backup", "--id", "unconfirmed", "--kind", "daily");
  assert.notEqual(result.code, 0);
  assert.match(result.output + result.error, /ACTIVE_ARTIFACT_MISMATCH/);
  assert.ok(
    !(await readdir(f.config.backupDir)).includes("unconfirmed"),
    "a refused backup must not remain as a recovery point",
  );
});

test("two pre-release points coexist, and only the newest is retained by name", async (t) => {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  const one = await f.control(
    "backup",
    "--id",
    "release-one",
    "--kind",
    "pre-release",
  );
  assert.equal(one.code, 0, one.output + one.error);
  await f.request("/api/diaries", { title: "两次发布之间", entries: [] });
  const two = await f.control(
    "backup",
    "--id",
    "release-two",
    "--kind",
    "pre-release",
  );
  assert.equal(two.code, 0, two.output + two.error);
  // Separate directories: taking the next pre-release point never overwrites
  // the previous one, which is what the maintainer's original wording implied.
  for (const id of ["release-one", "release-two"])
    await access(`${f.config.backupDir}/${id}/manifest.json`);
  const plan = JSON.parse(
    run(
      "node",
      "/repository/ops/backup-cli.mjs",
      "--config",
      `${f.root}/deploy.json`,
      "retention-plan",
    ),
  );
  assert.ok(!plan.localDelete.includes("release-two"), JSON.stringify(plan));
  assert.ok(plan.localDelete.includes("release-one"), JSON.stringify(plan));
  // A release's freshness check reads the same view, so it finds the point it
  // is about to overwrite without knowing anything about slots.
  const status = JSON.parse(
    run(
      "node",
      "/repository/ops/backup-cli.mjs",
      "--config",
      `${f.root}/deploy.json`,
      "status",
    ),
  );
  assert.equal(status.mode, "local");
  assert.equal(status.latestSnapshotId, "release-two");
});
