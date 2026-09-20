import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
assert.ok(ancestry.includes(current), "PRODUCTION_NOT_ON_MAIN");
let selected;
for (const sha of ancestry) {
  if (sha === current) break;
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
