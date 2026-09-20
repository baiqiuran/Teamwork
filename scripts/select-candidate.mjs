import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
const [runsPath, current] = process.argv.slice(2);
assert.match(current ?? "", /^[a-f0-9]{40}$/);
const runs = JSON.parse(await readFile(runsPath, "utf8"));
const candidates = new Map(
  runs
    .filter(
      (r) =>
        r.conclusion === "success" &&
        r.event === "push" &&
        r.head_branch === "main",
    )
    .sort((a, b) => a.id - b.id)
    .map((r) => [r.head_sha, r]),
);
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const ancestry = git(
  "rev-list",
  "--first-parent",
  "refs/remotes/origin/main",
).split("\n");
const descendsFromCurrent = (sha) => {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", current, sha],
    { stdio: "ignore" },
  );
  assert.ok([0, 1].includes(result.status), "INVALID_COMMIT_HISTORY");
  return result.status === 0;
};
// Candidates stay on main's first-parent chain, but the adopted production
// baseline may have arrived through a merged side branch.
assert.ok(descendsFromCurrent(ancestry[0]), "PRODUCTION_NOT_ON_MAIN");
let selected;
for (const sha of ancestry) {
  if (sha === current || !descendsFromCurrent(sha)) break;
  if (candidates.has(sha)) {
    selected = candidates.get(sha);
    break;
  }
}
console.log(
  JSON.stringify(
    selected
      ? { commit: selected.head_sha, runId: selected.id }
      : { commit: current, upToDate: true },
  ),
);
