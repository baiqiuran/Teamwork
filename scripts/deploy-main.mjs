import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sha256 } from "../ops/io.mjs";
import { sshControl } from "./ssh-control.mjs";
const env = process.env;
const remote = sshControl(env);
assert.match(env.GITHUB_REPOSITORY ?? "", /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
const directory = await mkdtemp(
  resolve(env.RUNNER_TEMP ?? tmpdir(), "daily-publish-"),
);
const run = (name, ...args) =>
  execFileSync(name, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
const execute = (name, ...args) =>
  execFileSync(name, args, { stdio: "inherit" });
const wait = () => new Promise((r) => setTimeout(r, 5000));
async function report(value) {
  const text = JSON.stringify(value);
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY)
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `\n\n发布结果：\n\n\`\`\`json\n${text}\n\`\`\`\n`,
    );
}
const started = Date.now();
const prepared = new Set();
while (Date.now() - started < 3000000) {
  const baseline = await remote("baseline");
  assert.equal(baseline.enabled, true, "AUTOMATION_DISABLED");
  if (baseline.frozen) {
    if (baseline.incidentId)
      await report(await remote(`status ${baseline.incidentId}`));
    await report({
      phase: "manual-intervention",
      actualCommit: baseline.commit,
      backup: baseline.backup,
    });
    throw new Error("INCIDENT_REQUIRES_MANUAL_RESOLUTION");
  }
  if (baseline.busy) {
    await wait();
    continue;
  }
  run(
    "git",
    "fetch",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  );
  const pages = JSON.parse(
    run(
      "gh",
      "api",
      "--paginate",
      "--slurp",
      `repos/${env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=100`,
    ),
  );
  const runsPath = resolve(directory, "runs.json");
  await writeFile(
    runsPath,
    JSON.stringify(pages.flatMap((p) => p.workflow_runs)),
  );
  const candidate = JSON.parse(
    run(
      process.execPath,
      "scripts/select-candidate.mjs",
      runsPath,
      baseline.commit,
    ),
  );
  if (candidate.upToDate) {
    await report({
      phase: "up-to-date",
      actualCommit: baseline.commit,
      slot: baseline.slot,
      backup: baseline.backup,
    });
    break;
  }
  const id = `ci-${candidate.runId}-${baseline.commit.slice(0, 16)}-${candidate.commit.slice(0, 16)}`;
  let state = await remote(`status ${id}`);
  if (state.phase === "absent") {
    const artifact = resolve(directory, id);
    if (!prepared.has(id)) {
      await mkdir(artifact);
      execute(
        "gh",
        "run",
        "download",
        String(candidate.runId),
        "--repo",
        env.GITHUB_REPOSITORY,
        "--name",
        `application-${candidate.commit}`,
        "--dir",
        artifact,
      );
      const receipt = JSON.parse(
        await readFile(resolve(artifact, "receipt.json"), "utf8"),
      );
      assert.equal(receipt.commit, candidate.commit);
      assert.equal(
        await sha256(resolve(artifact, "application.tar.gz")),
        receipt.sha256,
      );
      execute(
        process.execPath,
        "scripts/create-plan.mjs",
        "--from",
        baseline.commit,
        "--to",
        candidate.commit,
        "--output",
        resolve(artifact, "plan.json"),
      );
      execute(
        process.execPath,
        "scripts/verify-candidate.mjs",
        "--from",
        baseline.commit,
        "--current",
        baseline.commit,
        "--artifact",
        artifact,
        "--plan",
        resolve(artifact, "plan.json"),
        "--output",
        resolve(artifact, "upgrade.json"),
      );
      prepared.add(id);
    }
    const fresh = await remote("baseline");
    if (fresh.commit !== baseline.commit || fresh.busy) continue;
    const bundle = resolve(directory, `${id}.tar.gz`);
    execute(
      "tar",
      "-czf",
      bundle,
      "-C",
      artifact,
      "application.tar.gz",
      "receipt.json",
      "plan.json",
      "upgrade.json",
    );
    state = await remote(`upload ${id} ${await sha256(bundle)}`, bundle);
  }
  if (state.phase === "uploaded") {
    if (state.actualCommit) assert.equal(state.actualCommit, candidate.commit);
    if (state.baseline) assert.equal(state.baseline, baseline.commit);
    try {
      state = await remote(`release ${id} ${baseline.commit}`);
    } catch (error) {
      if (error.message === "BASELINE_CHANGED") continue;
      throw error;
    }
    if (state.phase === "busy") {
      await wait();
      continue;
    }
  }
  while (!["completed", "failed"].includes(state.phase)) {
    assert.ok(
      Date.now() - started < 3000000,
      "OBSERVER_BUDGET_EXCEEDED: server operation continues; rerun to query",
    );
    assert.ok(
      [
        "accepted",
        "preparing",
        "stopping",
        "data-operation",
        "data-ready",
        "activating",
        "may-be-open",
        "rolling-back",
        "rollback-data-ready",
        "rollback-may-be-open",
      ].includes(state.phase),
      "UNKNOWN_STATE_REQUIRES_RECONCILIATION",
    );
    await wait();
    state = await remote(`status ${id}`);
  }
  await report(state);
  assert.equal(
    state.phase,
    "completed",
    "RELEASE_FAILED: see recovery and backup status; do not restore data blindly",
  );
  // Re-read both main and production after the current operation finishes.
}
assert.ok(Date.now() - started < 3000000, "OBSERVER_BUDGET_EXCEEDED");
