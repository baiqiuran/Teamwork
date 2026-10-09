// Run only in the disposable systemd container described in docs/deploy-ecs.md.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
} from "node:fs";
import { createHash } from "node:crypto";
const enabled =
  process.env.DAILY_ECS_FIXTURE === "1" && existsSync("/fixture-ecs-only");
const run = (cmd, ...args) => execFileSync(cmd, args, { encoding: "utf8" });
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = "/bim/new-chat";
const unit = "new-chat.service";
const bundle = "/fixture-package";
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
async function ready() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch("http://127.0.0.1:4312/health/ready");
      if (r.ok) return await r.json();
    } catch {}
    await pause(100);
  }
  throw new Error("fixture service not ready");
}
before(async () => {
  if (!enabled) return;
  run(
    "useradd",
    "--system",
    "--user-group",
    "--shell",
    "/usr/sbin/nologin",
    "new-chat",
  );
  mkdirSync(`${root}/releases/baseline`, { recursive: true });
  mkdirSync(`${root}/data`);
  mkdirSync("/etc/new-chat");
  writeFileSync("/etc/new-chat/new-chat.env", "");
  cpSync("/repository/scripts/new-chat.service", `/etc/systemd/system/${unit}`);
  run(
    "tar",
    "-xzf",
    `${bundle}/application.tar.gz`,
    "-C",
    `${root}/releases/baseline`,
  );
  rmSync(`${root}/releases/baseline/release.json`);
  run(
    "npm",
    "ci",
    "--prefix",
    `${root}/releases/baseline`,
    "--omit=dev",
    "--ignore-scripts",
  );
  run("chown", "new-chat:new-chat", `${root}/data`);
  run("ln", "-s", `${root}/releases/baseline`, `${root}/current`);
  run("systemctl", "daemon-reload");
  run("systemctl", "start", unit);
  assert.equal(
    (await ready()).version,
    "development",
    "old bundles must retain their real unknown version",
  );
  writeFileSync(`${root}/data/fixture-sentinel.txt`, "persistent fixture data");
});
after(() => {
  if (enabled) run("systemctl", "stop", unit);
});
async function candidate(id, modify) {
  run("systemctl", "stop", unit);
  rmSync(`${root}/NEEDS_ATTENTION`, { force: true });
  run("ln", "-sfn", `${root}/releases/baseline`, `${root}/current`);
  run("systemctl", "start", unit);
  await ready();
  const upload = `/tmp/new-chat-upload.${id}`;
  mkdirSync(upload);
  for (const file of ["application.tar.gz", "receipt.json"])
    cpSync(`${bundle}/${file}`, `${upload}/${file}`);
  for (const file of ["deploy-ecs.sh", "ecs-release.mjs"])
    cpSync(`/repository/scripts/${file}`, `${upload}/${file}`);
  if (modify) await modify(upload);
  const pid = run("systemctl", "show", unit, "-p", "MainPID", "--value").trim();
  const result = spawnSync(
    "bash",
    [`${upload}/deploy-ecs.sh`, `${upload}/application.tar.gz`],
    { encoding: "utf8", timeout: 120000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  return { result, record: json(`${upload}/release-record.json`), pid, upload };
}
test(
  "ECS install confirms archive, actual health version and paired snapshot",
  { skip: !enabled },
  async () => {
    const f = await candidate("good");
    assert.equal(f.result.status, 0, f.result.stderr);
    const expected = json(`${bundle}/receipt.json`);
    assert.equal(f.record.status, "completed");
    assert.equal(f.record.artifactSha256, hash(`${bundle}/application.tar.gz`));
    assert.equal(f.record.version, expected.version);
    assert.equal(f.record.health.version, (await ready()).version);
    assert.equal(f.record.health.ready, true);
    assert.equal(
      readFileSync(`${f.record.snapshot}/data/fixture-sentinel.txt`, "utf8"),
      "persistent fixture data",
    );
    assert.equal(
      readFileSync(`${root}/data/fixture-sentinel.txt`, "utf8"),
      "persistent fixture data",
    );
    assert.ok(f.record.startedAt && f.record.finishedAt && f.record.release);
  },
);
test(
  "corrupt ECS archive is rejected while the original service stays running",
  { skip: !enabled },
  async () => {
    const f = await candidate("corrupt", (upload) => {
      const archive = `${upload}/application.tar.gz`;
      writeFileSync(
        archive,
        Buffer.concat([readFileSync(archive), Buffer.from("corruption")]),
      );
    });
    assert.notEqual(f.result.status, 0);
    assert.equal(f.record.status, "failed");
    assert.notEqual(f.record.artifactSha256, f.record.expectedArtifactSha256);
    assert.equal(f.record.snapshot, null);
    assert.equal(
      run("systemctl", "show", unit, "-p", "MainPID", "--value").trim(),
      f.pid,
    );
    assert.equal((await ready()).version, "development");
  },
);
test(
  "valid archive with a different embedded identity is rejected before stopping",
  { skip: !enabled },
  async () => {
    const f = await candidate("identity", (upload) =>
      rewrite(upload, (directory) => {
        const metadata = json(`${directory}/release.json`);
        metadata.commit = "b".repeat(40);
        metadata.version = `${metadata.commit}-dirty.${metadata.sourceDigest.slice(0, 12)}`;
        writeFileSync(`${directory}/release.json`, JSON.stringify(metadata));
      }),
    );
    assert.notEqual(f.result.status, 0);
    assert.equal(f.record.status, "failed");
    assert.equal(f.record.snapshot, null);
    assert.equal(
      run("systemctl", "show", unit, "-p", "MainPID", "--value").trim(),
      f.pid,
    );
  },
);
test(
  "ready response with the wrong runtime version retains a failed record and stops service",
  { skip: !enabled },
  async () => {
    const f = await candidate("health", (upload) =>
      rewrite(upload, (directory) => {
        writeFileSync(
          `${directory}/build/server/main.js`,
          `import http from 'node:http';http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({ready:true,version:'development'}))}).listen(4312,'127.0.0.1');`,
        );
      }),
    );
    assert.notEqual(f.result.status, 0);
    assert.equal(f.record.status, "failed");
    assert.equal(f.record.health.version, "development");
    assert.ok(f.record.snapshot);
    assert.equal(
      run("systemctl", "show", unit, "-p", "MainPID", "--value").trim(),
      "0",
    );
    assert.ok(existsSync(`${root}/NEEDS_ATTENTION`));
  },
);
function rewrite(upload, modify) {
  const directory = `${upload}/rewrite`;
  mkdirSync(directory);
  run("tar", "-xzf", `${upload}/application.tar.gz`, "-C", directory);
  modify(directory);
  run(
    "tar",
    "-czf",
    `${upload}/application.tar.gz`,
    "-C",
    directory,
    "build",
    "dist",
    "package.json",
    "package-lock.json",
    "release.json",
  );
  const receipt = json(`${upload}/receipt.json`);
  receipt.sha256 = hash(`${upload}/application.tar.gz`);
  writeFileSync(`${upload}/receipt.json`, JSON.stringify(receipt));
}
