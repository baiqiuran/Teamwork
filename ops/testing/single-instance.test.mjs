import assert from "node:assert/strict";
import { test } from "node:test";
import { access, cp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fixture, run } from "./fixture.mjs";
import { sha256 } from "../io.mjs";

const UNIT = "daily-flow.service";

const invoke = (entry, configPath, ...args) =>
  spawnSync(
    "node",
    [`/repository/ops/${entry}.mjs`, "--config", configPath, ...args],
    { encoding: "utf8" },
  );

test("the single instance unit is a repository file systemd can load and it shares the data lock", async (t) => {
  t.after(() => {
    run("rm", "-f", `/etc/systemd/system/${UNIT}`);
    run("systemctl", "daemon-reload");
  });
  const shows = (property) =>
    run("systemctl", "show", UNIT, `--property=${property}`, "--value").trim();
  run("cp", `/repository/ops/systemd/${UNIT}`, `/etc/systemd/system/${UNIT}`);
  run("systemctl", "daemon-reload");
  assert.equal(shows("LoadState"), "loaded");
  assert.equal(
    shows("UnitFileState"),
    "disabled",
    "installable, and the fixture does not enable production",
  );
  assert.equal(shows("User"), "daily-flow");
  assert.equal(shows("Group"), "daily-flow");
  const execStart = shows("ExecStart");
  assert.match(execStart, /\/usr\/bin\/flock --nonblock /, execStart);
  assert.match(execStart, /build\/server\/main\.js(?= ;)/, execStart);
  // The lock the unit takes has to be the lock the controller takes, or a
  // snapshot and the application open the database at the same time.
  const configured = JSON.parse(
    await readFile("/repository/ops/config.example.json", "utf8"),
  );
  assert.equal(
    shows("ReadWritePaths"),
    `/var/lib/daily-flow ${configured.dataLock}`,
  );
  assert.ok(execStart.includes(configured.dataLock), execStart);
  assert.equal(configured.unit, UNIT);
  assert.ok(!("slots" in configured) && !("activeSlot" in configured));
  assert.doesNotMatch(
    execStart,
    /owner-guard/,
    "must not carry slot ownership",
  );
});

const mainPid = (unit) =>
  Number(
    run("systemctl", "show", unit, "--property=MainPID", "--value").trim(),
  );
const isActive = (unit) =>
  run("systemctl", "show", unit, "--property=ActiveState", "--value").trim();
const cli = (configPath, action, ...args) =>
  JSON.parse(
    run(
      "node",
      "/repository/ops/backup-cli.mjs",
      "--config",
      configPath,
      action,
      ...args,
    ),
  );

/** Copy a real snapshot with another id, age and kind, re-signing its manifest. */
async function copySnapshot(f, source, id, days, kind) {
  const directory = `${f.config.backupDir}/${id}`;
  await cp(`${f.config.backupDir}/${source}`, directory, { recursive: true });
  const path = `${directory}/manifest.json`;
  const manifest = JSON.parse(await readFile(path, "utf8"));
  Object.assign(manifest, {
    id,
    kind,
    snapshotAt: new Date(Date.now() - days * 86400000).toISOString(),
  });
  await writeFile(path, JSON.stringify(manifest));
  await writeFile(`${directory}/manifest.sha256`, await sha256(path));
}

test("backup and paired restore stop and start the one instance, never slot machinery", async (t) => {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  assert.ok(!("slots" in f.config), "the configuration names no slots");
  assert.ok(
    !("activeSlot" in f.config),
    "the configuration has no active slot",
  );
  const started = mainPid(f.config.unit);
  assert.ok(started > 0, "the single instance is running before the backup");
  const backup = await f.control("backup", "--id", "single", "--kind", "daily");
  assert.equal(backup.code, 0, backup.output + backup.error);
  assert.notEqual(mainPid(f.config.unit), started, "the unit was restarted");
  assert.equal(isActive(f.config.unit), "active");
  const directory = `${f.config.backupDir}/single`;
  const manifest = JSON.parse(
    await readFile(`${directory}/manifest.json`, "utf8"),
  );
  assert.deepEqual(manifest.materials.map((material) => material.name).sort(), [
    "application.tar.gz",
    "config.env",
    "data.tar.gz",
    "node",
  ]);
  for (const material of manifest.materials)
    assert.equal(
      await sha256(`${directory}/${material.name}`),
      material.sha256,
      `${material.name} digest`,
    );
  await f.request("/api/diaries", { title: "恢复时应移除", entries: [] });
  const recovered = await f.control(
    "restore",
    "--id",
    "recover-single",
    "--snapshot",
    "single",
  );
  assert.equal(recovered.code, 0, recovered.output + recovered.error);
  assert.equal(isActive(f.config.unit), "active");
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
  // The slot ownership permit is what stops a foreign slot opening the data;
  // a single instance must not grow one.
  await assert.rejects(access(`${f.root}/control/owner.json`));
  assert.ok(
    !(
      "slot" in
      JSON.parse(await readFile(`${f.root}/control/runtime.json`, "utf8"))
    ),
    "the recorded runtime identity names no slot",
  );
});

/** The production single instance carries a deep-health credential; so do we. */
async function servingInstance(t) {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  const token = `single_instance_health_token_${randomUUID().replaceAll("-", "")}`;
  await writeFile(`${f.root}/health-token`, token);
  const environment = await readFile(`${f.root}/config.env`, "utf8");
  await writeFile(
    `${f.root}/config.env`,
    `${environment}DAILY_HEALTH_TOKEN=${token}\n`,
    { mode: 0o600 },
  );
  f.config.healthTokenFile = `${f.root}/health-token`;
  await writeFile(`${f.root}/deploy.json`, JSON.stringify(f.config));
  run("systemctl", "restart", f.config.unit);
  for (let attempt = 0; attempt < 200; attempt++) {
    const ready = await fetch(new URL("/health/ready", f.origin));
    if (ready.status === 200) return f;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.fail("the single instance did not come back with a health credential");
}

test("reconciling after a reboot serves the single instance without naming a slot", async (t) => {
  const f = await servingInstance(t);
  // A host has a recorded identity from its first paired restore onward.
  const seed = await f.control("backup", "--id", "seed", "--kind", "daily");
  assert.equal(seed.code, 0, seed.output + seed.error);
  const adopted = await f.control(
    "restore",
    "--id",
    "adopt",
    "--snapshot",
    "seed",
  );
  assert.equal(adopted.code, 0, adopted.output + adopted.error);
  const commit = JSON.parse(
    await readFile(`${f.root}/current/release.json`, "utf8"),
  ).commit;
  const reconciled = invoke("reconcile", `${f.root}/deploy.json`);
  assert.equal(reconciled.status, 0, reconciled.stdout + reconciled.stderr);
  const boot = JSON.parse(reconciled.stdout);
  assert.equal(boot.actualCommit, commit, reconciled.stdout);
  assert.ok(!("slot" in boot), reconciled.stdout);
  assert.equal((await fetch(`${f.origin}/login`)).status, 200);
  const backup = await f.control(
    "backup",
    "--id",
    "after-reboot",
    "--kind",
    "daily",
  );
  assert.equal(backup.code, 0, backup.output + backup.error);
});

test("an incident left by a failed backup is resolved on a single instance", async (t) => {
  const f = await servingInstance(t);
  const commit = JSON.parse(
    await readFile(`${f.root}/current/release.json`, "utf8"),
  ).commit;
  // The shape control writes when a data operation failed to reopen the site.
  await writeFile(
    `${f.root}/control/incident.json`,
    JSON.stringify({
      id: "crashed-backup",
      at: new Date().toISOString(),
      reason: "Operation failed while data was controlled",
    }),
  );
  const resolved = await f.control(
    "resolve-incident",
    "--id",
    "resolve-single",
    "--incident",
    "crashed-backup",
    "--expected-commit",
    commit,
    "--note",
    "已核对单实例数据与版本",
  );
  assert.equal(resolved.code, 0, resolved.output + resolved.error);
  assert.equal((await fetch(`${f.origin}/login`)).status, 200);
  await assert.rejects(access(`${f.root}/control/incident.json`));
});

test("local retention prunes the day beyond seven and keeps the latest pre-release point for one instance", async (t) => {
  const f = await fixture();
  t.after(() => run("systemctl", "stop", `${f.id}.service`));
  const source = await f.control("backup", "--id", "source", "--kind", "daily");
  assert.equal(source.code, 0, source.output + source.error);
  await writeFile(
    `${f.root}/deploy.json`,
    JSON.stringify({ ...f.config, backupMode: "local" }),
  );
  for (const [id, days, kind] of [
    ["fresh", 0, "daily"],
    ["recent", 3, "daily"],
    ["stale", 9, "daily"],
    ["before-change", 12, "pre-release"],
  ])
    await copySnapshot(f, "source", id, days, kind);
  const plan = cli(`${f.root}/deploy.json`, "retention-plan");
  assert.ok(plan.localDelete.includes("stale"), JSON.stringify(plan));
  for (const kept of ["fresh", "recent", "before-change"])
    assert.ok(!plan.localDelete.includes(kept), `${kept} must survive`);
  const applied = cli(`${f.root}/deploy.json`, "retention-apply");
  assert.ok(applied.localDelete.includes("stale"), JSON.stringify(applied));
  await assert.rejects(access(`${f.config.backupDir}/stale`));
  for (const kept of ["fresh", "recent", "before-change"])
    await access(`${f.config.backupDir}/${kept}/manifest.json`);
});
