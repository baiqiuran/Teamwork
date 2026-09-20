import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
const args = process.argv.slice(2),
  options = {};
while (args.length) {
  const key = args.shift();
  assert.ok(
    ["--from", "--to", "--output", "--notes"].includes(key) &&
      args.length &&
      !options[key],
  );
  options[key] = args.shift();
}
for (const key of ["--from", "--to"])
  assert.match(options[key] ?? "", /^[a-f0-9]{40}$/);
assert.ok(options["--output"]);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
git("merge-base", "--is-ancestor", options["--from"], options["--to"]);
// Notes are keyed by exact file blob, so a PR can include its own review notes
// without guessing the future merge commit SHA.
const notes = JSON.parse(
  options["--notes"]
    ? await readFile(options["--notes"], "utf8")
    : git("show", `${options["--to"]}:docs/migrations/automatic.json`),
);
const changes = [];
for (const commit of git(
  "rev-list",
  "--reverse",
  `${options["--from"]}..${options["--to"]}`,
)
  .split("\n")
  .filter(Boolean)) {
  const paths = new Set(
    git("diff-tree", "--no-commit-id", "--name-only", "-r", "-m", commit)
      .split("\n")
      .filter(
        (p) =>
          p.startsWith("server/") &&
          (p.includes("/infrastructure/") ||
            p === "server/composition/resources.ts"),
      ),
  );
  for (const path of paths) {
    const blob = git("rev-parse", `${commit}:${path}`),
      note = notes[blob];
    const kind =
      path.startsWith("server/infrastructure/sqlite/") ||
      path === "server/composition/resources.ts"
        ? "additive"
        : "runtime";
    assert.ok(
      note?.automatic === true &&
        note.description?.trim() &&
        note.kind === kind,
      `MIGRATION_NOTES_MISSING: ${commit}:${path}:${blob}`,
    );
    changes.push({ commit, path, kind, description: note.description });
  }
}
await writeFile(
  options["--output"],
  JSON.stringify(
    {
      from: options["--from"],
      to: options["--to"],
      automatic: true,
      description:
        "按精确文件版本的已审阅说明验证完整升级跨度；破坏性操作仍由候选检查拒绝。",
      changes,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
