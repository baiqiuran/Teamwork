import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
test("qualified candidates follow main ancestry, never completion order or a non-main branch", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "deploy-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  const commits = [];
  for (let n = 0; n < 3; n++) {
    await writeFile(resolve(root, "version"), String(n));
    git("add", ".");
    git("commit", "-m", "version " + n);
    commits.push(git("rev-parse", "HEAD"));
  }
  git("update-ref", "refs/remotes/origin/main", commits[2]);
  const runs = [
    {
      id: 3,
      head_sha: commits[2],
      head_branch: "main",
      event: "push",
      conclusion: "success",
    },
    {
      id: 4,
      head_sha: commits[1],
      head_branch: "main",
      event: "push",
      conclusion: "success",
    },
  ];
  const path = resolve(root, "runs.json");
  await writeFile(path, JSON.stringify(runs));
  const select = (baseline) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [resolve("scripts/select-candidate.mjs"), path, baseline],
        { cwd: root, encoding: "utf8" },
      ),
    );
  assert.equal(select(commits[0]).commit, commits[2]);
  assert.equal(select(commits[2]).upToDate, true);
  runs[0].conclusion = "failure";
  await writeFile(path, JSON.stringify(runs));
  assert.equal(select(commits[0]).commit, commits[1]);
  assert.equal(select(commits[2]).upToDate, true);
  // Existing production may be a side-branch commit later merged into main.
  git("checkout", "-b", "legacy", commits[1]);
  await writeFile(resolve(root, "legacy"), "previously deployed version");
  git("add", "legacy");
  git("commit", "-m", "legacy deployment");
  const legacy = git("rev-parse", "HEAD");
  git("checkout", "main");
  git("merge", "--no-ff", "legacy", "-m", "adopt deployed branch");
  const merged = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", merged);
  runs[0].conclusion = "success";
  runs.push({
    id: 5,
    head_sha: merged,
    head_branch: "main",
    event: "push",
    conclusion: "success",
  });
  await writeFile(path, JSON.stringify(runs));
  assert.equal(select(legacy).commit, merged);
  runs.at(-1).conclusion = "failure";
  await writeFile(path, JSON.stringify(runs));
  assert.equal(
    select(legacy).upToDate,
    true,
    "never select a main version that predates the deployed branch merge",
  );
  git("checkout", "legacy");
  await writeFile(resolve(root, "unmerged"), "not adopted");
  git("add", "unmerged");
  git("commit", "-m", "unmerged work");
  assert.throws(
    () => select(git("rev-parse", "HEAD")),
    /PRODUCTION_NOT_ON_MAIN/,
  );
});
test("migration plans require explicit notes for exact persistent code blobs", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "deploy-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  await writeFile(resolve(root, "initial"), "x");
  git("add", ".");
  git("commit", "-m", "base");
  const baseline = git("rev-parse", "HEAD");
  await mkdir(resolve(root, "server/composition"), { recursive: true });
  await writeFile(
    resolve(root, "server/composition/resources.ts"),
    "// read-only initialization change",
  );
  git("add", ".");
  git("commit", "-m", "change");
  const candidate = git("rev-parse", "HEAD");
  const notes = resolve(root, "notes.json"),
    output = resolve(root, "plan.json");
  await writeFile(notes, "{}");
  const invoke = () =>
    spawnSync(
      process.execPath,
      [
        resolve("scripts/create-plan.mjs"),
        "--from",
        baseline,
        "--to",
        candidate,
        "--notes",
        notes,
        "--output",
        output,
      ],
      { cwd: root, encoding: "utf8" },
    );
  assert.match(invoke().stderr, /MIGRATION_NOTES_MISSING/);
  const blob = git("rev-parse", `${candidate}:server/composition/resources.ts`);
  await writeFile(
    notes,
    JSON.stringify({
      [blob]: {
        automatic: true,
        kind: "additive",
        description: "Only read-only health inspection added",
      },
    }),
  );
  assert.equal(invoke().status, 0);
});
