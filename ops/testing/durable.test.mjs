import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { slotsFixture } from "./slots-fixture.mjs";
import { run, port } from "./fixture.mjs";

async function fixture(t) {
  const f = await slotsFixture(t);
  const baseline = JSON.parse(
    await readFile(`${f.root}/current/release.json`, "utf8"),
  ).commit;
  await writeFile(
    `${f.root}/control/runtime.json`,
    JSON.stringify({
      slot: "blue",
      commit: baseline,
      artifact: f.config.artifact,
    }),
  );
  await writeFile(
    `${f.root}/control/owner.json`,
    JSON.stringify({
      slot: "blue",
      commit: baseline,
      bootId: (
        await readFile("/proc/sys/kernel/random/boot_id", "utf8")
      ).trim(),
    }),
  );
  for (const [slot, settings] of Object.entries(f.config.slots)) {
    const path = `/etc/systemd/system/${settings.unit}`;
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace(
        "[Service]",
        `[Service]\nExecStartPre=+/usr/local/bin/node /repository/ops/owner-guard.mjs --config ${f.root}/deploy.json --slot ${slot}`,
      ),
    );
  }
  run("systemctl", "daemon-reload");
  const invoke = async (script, ...args) => {
    const child = spawn(
      process.execPath,
      [
        resolve(`ops/${script}.mjs`),
        "--config",
        `${f.root}/deploy.json`,
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      error = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (error += chunk));
    const [code] = await once(child, "exit");
    return { code, output, error };
  };
  const wait = async (id, phases = ["completed", "failed"]) => {
    for (let n = 0; n < 1500; n++) {
      try {
        const state = JSON.parse(
          await readFile(`${f.root}/control/operations/${id}.json`, "utf8"),
        );
        if (phases.includes(state.phase)) return state;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error("Operation did not reach expected stage");
  };
  return { ...f, baseline, invoke, wait };
}

test("SSH observer interruption leaves systemd release running; retries and startup guard preserve one owner", async (t) => {
  const f = await fixture(t),
    id = `ssh-${randomUUID()}`;
  const sshPort = await port();
  run("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", `${f.root}/key`);
  const publicKey = (await readFile(`${f.root}/key.pub`, "utf8")).trim();
  await writeFile(
    `${f.root}/authorized`,
    `command="/usr/local/bin/node /repository/ops/dispatch.mjs --config ${f.root}/deploy.json release --id ${id} --candidate /candidate-artifact --baseline ${f.baseline}; sleep 30",no-port-forwarding,no-agent-forwarding,no-X11-forwarding ${publicKey}\n`,
  );
  await mkdir("/run/sshd", { recursive: true });
  const sshd = spawn(
    "/usr/sbin/sshd",
    [
      "-D",
      "-e",
      "-p",
      String(sshPort),
      "-o",
      "ListenAddress=127.0.0.1",
      "-o",
      `AuthorizedKeysFile=${f.root}/authorized`,
      "-o",
      "StrictModes=no",
      "-o",
      "PermitRootLogin=prohibit-password",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "UsePAM=no",
    ],
    { stdio: "ignore" },
  );
  t.after(() => sshd.kill());
  await new Promise((done) => setTimeout(done, 200));
  const ssh = spawn(
    "ssh",
    [
      "-p",
      String(sshPort),
      "-i",
      `${f.root}/key`,
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${f.root}/known_hosts`,
      "root@127.0.0.1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    error = "";
  ssh.stderr.on("data", (chunk) => (error += chunk));
  await new Promise((done, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`SSH submission timed out: ${error}`)),
      15000,
    );
    ssh.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes('"accepted"')) {
        clearTimeout(timer);
        done();
      }
    });
    ssh.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`SSH exited ${code}: ${output} ${error}`));
    });
  });
  ssh.kill("SIGKILL");
  const state = await f.wait(id);
  assert.equal(state.phase, "completed", JSON.stringify(state));
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
  const retry = await f.invoke(
    "dispatch",
    "release",
    "--id",
    id,
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    f.baseline,
  );
  assert.equal(retry.code, 0, retry.output + retry.error);
  assert.equal(JSON.parse(retry.output).finishedAt, state.finishedAt);
  const conflict = await f.invoke(
    "dispatch",
    "release",
    "--id",
    id,
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    "0".repeat(40),
  );
  assert.notEqual(conflict.code, 0);
  assert.throws(() => run("systemctl", "start", f.config.slots.blue.unit));
  assert.equal(
    run(
      "systemctl",
      "show",
      f.config.slots.blue.unit,
      "--property=MainPID",
      "--value",
    ).trim(),
    "0",
  );
  // Simulate startup with the persisted permit belonging to a previous boot.
  run("systemctl", "stop", f.config.slots.green.unit);
  const ownerPath = `${f.root}/control/owner.json`;
  await writeFile(
    ownerPath,
    JSON.stringify({
      ...JSON.parse(await readFile(ownerPath, "utf8")),
      bootId: "previous-boot",
    }),
  );
  assert.throws(() => run("systemctl", "start", f.config.slots.green.unit));
  const rebooted = await f.invoke("reconcile");
  assert.equal(rebooted.code, 0, rebooted.output + rebooted.error);
  assert.equal(JSON.parse(rebooted.output).actualCommit, state.actualCommit);
  assert.equal(
    await f.request(`/api/attachments/${f.attachment}`, undefined, true),
    "original attachment bytes",
  );
});

test("interrupted pre-open worker reconciles matching backup without repeating migration", async (t) => {
  const f = await fixture(t),
    id = `crash-${randomUUID()}`;
  const greenPath = `/etc/systemd/system/${f.config.slots.green.unit}`;
  await writeFile(
    greenPath,
    (await readFile(greenPath, "utf8")).replace(
      "[Service]",
      "[Service]\nExecStartPre=/bin/sleep 3",
    ),
  );
  run("systemctl", "daemon-reload");
  const accepted = await f.invoke(
    "dispatch",
    "release",
    "--id",
    id,
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    f.baseline,
  );
  assert.equal(accepted.code, 0, accepted.output + accepted.error);
  await f.wait(id, ["activating"]);
  run(
    "systemctl",
    "kill",
    "--kill-who=all",
    "--signal=SIGKILL",
    `daily-flow-operation-${id}.service`,
  );
  await new Promise((done) => setTimeout(done, 200));
  const recovered = await f.invoke("reconcile");
  assert.equal(recovered.code, 0, recovered.output + recovered.error);
  assert.equal(JSON.parse(recovered.output).recovery, "baseline-restored");
  assert.equal((await f.wait(id)).phase, "failed");
  assert.equal(
    await f.request(`/api/attachments/${f.attachment}`, undefined, true),
    "original attachment bytes",
  );
  const retry = await f.invoke(
    "dispatch",
    "release",
    "--id",
    id,
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    f.baseline,
  );
  assert.equal(JSON.parse(retry.output).phase, "failed");
});

test("worker death after opening preserves new work and requires explicit incident resolution", async (t) => {
  const f = await fixture(t),
    id = `opened-${randomUUID()}`;
  const hook = `${f.root}/pause-open.mjs`;
  await writeFile(
    hook,
    `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
if(process.argv[1].endsWith('/control.mjs')) { const original=fs.rm; fs.rm=async function(path,...args) {
const result=await original.call(this,path,...args); if(path===${JSON.stringify(f.root + "/maintenance")}) { await fs.writeFile(${JSON.stringify(f.root + "/opened")}, 'ready'); await new Promise(()=>setInterval(()=>{},1000)); } return result; }; syncBuiltinESMExports(); }`,
  );
  const dropIn = `/etc/systemd/system/daily-flow-operation-${id}.service.d`;
  await mkdir(dropIn, { recursive: true });
  await writeFile(
    `${dropIn}/test.conf`,
    `[Service]\nEnvironment=NODE_OPTIONS=--import=${hook}\n`,
  );
  run("systemctl", "daemon-reload");
  const accepted = await f.invoke(
    "dispatch",
    "release",
    "--id",
    id,
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    f.baseline,
  );
  assert.equal(accepted.code, 0, accepted.output + accepted.error);
  for (let n = 0; n < 1000; n++) {
    try {
      await access(`${f.root}/opened`);
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 20));
    }
  }
  await access(`${f.root}/opened`);
  const entryId = randomUUID();
  let diary = await f.request("/api/diaries", {
    title: "中断后必须保留",
    entries: [{ id: entryId, body: "开放后已提交" }],
  });
  diary = await f.request(
    `/api/diaries/${diary.id}/entries/${entryId}/attachments`,
    {
      version: diary.version,
      requestId: randomUUID(),
      name: "crash.txt",
      base64: Buffer.from("survive worker death").toString("base64"),
    },
  );
  diary = await f.request(`/api/diaries/${diary.id}/submit`, {
    version: diary.version,
    requestId: randomUUID(),
  });
  const attachment = diary.published.entries[0].attachments[0].id;
  run(
    "systemctl",
    "kill",
    "--kill-who=all",
    "--signal=SIGKILL",
    `daily-flow-operation-${id}.service`,
  );
  await new Promise((done) => setTimeout(done, 200));
  const reconciled = await f.invoke("reconcile");
  assert.notEqual(reconciled.code, 0);
  assert.equal(JSON.parse(reconciled.output).recovery, "manual-intervention");
  assert.equal((await fetch(f.origin + "/login")).status, 503);
  assert.equal(
    await readFile(`${f.root}/data/attachments/${attachment}`, "utf8"),
    "survive worker death",
  );
  const runtime = JSON.parse(
    await readFile(`${f.root}/control/runtime.json`, "utf8"),
  );
  const incident = JSON.parse(
    await readFile(`${f.root}/control/incident.json`, "utf8"),
  );
  const fixed = await f.control(
    "resolve-incident",
    "--id",
    "resolve-interruption",
    "--incident",
    incident.id,
    "--expected-commit",
    runtime.commit,
    "--note",
    "已核对开放后新增日报和附件",
  );
  assert.equal(fixed.code, 0, fixed.output + fixed.error);
  assert.equal(
    (await f.request(`/api/diaries/${diary.id}`)).published.entries[0].body,
    "开放后已提交",
  );
});

test("corrupt control state freezes instead of guessing a data owner", async (t) => {
  const f = await fixture(t);
  await writeFile(`${f.root}/control/runtime.json`, "broken state");
  const result = await f.invoke("reconcile");
  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.output).recovery, "manual-intervention");
  assert.equal((await fetch(f.origin + "/login")).status, 503);
  assert.equal(
    await readFile(`${f.root}/data/attachments/${f.attachment}`, "utf8"),
    "original attachment bytes",
  );
});

test("stopped owner cannot restart between snapshot completion and activation", async (t) => {
  const f = await fixture(t);
  const hook = `${f.root}/pause-data.mjs`;
  await writeFile(
    hook,
    `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
if(process.argv[1].endsWith('/control.mjs')) { const original=fs.readFile; fs.readFile=async function(path,...args) {
const result=await original.call(this,path,...args); if(String(path).endsWith('/paused-owner.json') && String(result).includes('"data-ready"')) {
await fs.writeFile(${JSON.stringify(f.root + "/paused")}, 'ready');
while(true) { try { await fs.access(${JSON.stringify(f.root + "/resume")}); break; } catch {} await new Promise(r=>setTimeout(r,20)); }
} return result; }; syncBuiltinESMExports(); }`,
  );
  const pending = f.controlWith(
    ["--import", hook],
    "release",
    "--id",
    "paused-owner",
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    f.baseline,
  );
  for (let n = 0; n < 1500; n++) {
    try {
      await access(`${f.root}/paused`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  await access(`${f.root}/paused`);
  let denied = false;
  try {
    run("systemctl", "start", f.config.slots.blue.unit);
  } catch {
    denied = true;
  }
  // Always release the test barrier, including on a failing regression.
  run("systemctl", "stop", f.config.slots.blue.unit);
  await writeFile(`${f.root}/resume`, "resume");
  const result = await pending;
  assert.ok(denied, "A stopped slot retained its startup permission");
  assert.equal(result.code, 0, result.output + result.error);
});

test("controller rejects material identity differing from the accepted request", async (t) => {
  const f = await fixture(t);
  await mkdir(`${f.root}/control/requests`, { recursive: true });
  await writeFile(
    `${f.root}/control/requests/changed.json`,
    JSON.stringify({ fingerprint: "accepted-original-content" }),
  );
  const result = await f.control(
    "release",
    "--id",
    "changed",
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    f.baseline,
  );
  assert.notEqual(result.code, 0);
  assert.match(result.output + result.error, /ACCEPTED_REQUEST_CHANGED/);
  assert.equal((await fetch(f.origin + "/login")).status, 200);
  assert.equal(
    JSON.parse(await readFile(`${f.root}/current/release.json`, "utf8")).commit,
    f.baseline,
  );
});
