import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { npmCli } from "./npm-cli.mjs";
import { fileBlob, verifyMove } from "./migration-moves.mjs";

const args = process.argv.slice(2);
const options = {};
while (args.length) {
  const key = args.shift();
  assert.ok(
    [
      "--from",
      "--current",
      "--artifact",
      "--plan",
      "--output",
      "--repository",
    ].includes(key) && args.length,
    "Unknown or missing option",
  );
  assert.ok(!options[key], "Duplicate option");
  options[key] = args.shift();
}
for (const name of ["--from", "--current"])
  assert.match(options[name] ?? "", /^[0-9a-f]{40}$/);
assert.equal(
  options["--from"],
  options["--current"],
  "BASELINE_CHANGED: revalidate from the current production version",
);
for (const key of ["--artifact", "--plan", "--output"])
  assert.ok(options[key], `${key} is required`);
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(options["--repository"] ?? app);
const from = options["--from"];
const artifact = resolve(options["--artifact"]);
const receipt = JSON.parse(
  await readFile(resolve(artifact, "receipt.json"), "utf8"),
);
const to = receipt.commit;
const git = (...args) =>
  execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
for (const commit of [from, to]) {
  assert.match(commit ?? "", /^[0-9a-f]{40}$/);
  assert.equal(
    git("cat-file", "-t", commit),
    "commit",
    "Missing commit history",
  );
}
git("merge-base", "--is-ancestor", from, to);
assert.equal(receipt.schema, 1);
assert.equal(
  receipt.platform,
  process.platform,
  "Candidate must run on the validation platform",
);
assert.equal(receipt.architecture, process.arch);
assert.equal(receipt.node, process.version);
for (const check of [
  "architecture",
  "types",
  "build",
  "api",
  "browser",
  "production-runtime",
])
  assert.ok(receipt.checks.includes(check), `Missing check: ${check}`);
const archive = resolve(artifact, "application.tar.gz");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(
  hash(await readFile(archive)),
  receipt.sha256,
  "ARTIFACT_DIGEST_MISMATCH",
);
const planBytes = await readFile(resolve(options["--plan"]));
const plan = JSON.parse(planBytes);
assert.equal(plan.from, from, "Migration plan source mismatch");
assert.equal(plan.to, to, "Migration plan target mismatch");
assert.ok(plan.description?.trim(), "Migration explanation required");
assert.equal(
  plan.automatic,
  true,
  "DESTRUCTIVE_MIGRATION: manual maintenance required",
);
assert.ok(Array.isArray(plan.changes));
const changes = [];
const commits = git("rev-list", "--reverse", `${from}..${to}`)
  .split(/\r?\n/)
  .filter(Boolean);
for (const commit of commits) {
  const paths = git(
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    "-m",
    commit,
  )
    .split(/\r?\n/)
    .filter(Boolean);
  for (const path of new Set(
    paths.filter(
      (path) =>
        path.startsWith("server/") &&
        (path.includes("/infrastructure/") ||
          path === "server/composition/resources.ts"),
    ),
  )) {
    const note = plan.changes.find(
      (item) => item.commit === commit && item.path === path,
    );
    assert.ok(
      note?.description?.trim(),
      `MIGRATION_NOTES_MISSING: ${commit}:${path}`,
    );
    const migration =
      path.startsWith("server/infrastructure/sqlite/") ||
      path === "server/composition/resources.ts";
    assert.equal(
      note.kind,
      migration ? "additive" : "runtime",
      `MIGRATION_KIND_MISMATCH: ${commit}:${path}`,
    );
    if (!fileBlob(git, commit, path)) verifyMove(git, commit, path, note);
    const diff = git(
      "show",
      "--format=",
      "--first-parent",
      "--unified=0",
      commit,
      "--",
      path,
    );
    const additions = diff
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*(?:\/\/|--).*$/gm, "");
    if (migration) {
      // Conservative at the migration boundary: quoted names, comments and line
      // breaks must not turn destructive operations into an automatic release.
      assert.ok(
        // SQLite UPDATE is followed by a table/OR clause, not a call parenthesis.
        // In particular Node crypto's .update(...) does not rewrite database rows.
        !/\b(DROP|TRUNCATE|DELETE|UPDATE(?!\s*\()|RENAME|REPLACE)\b/i.test(
          additions,
        ),
        `DESTRUCTIVE_MIGRATION: data rewriting SQL in ${path}`,
      );
    } else {
      assert.ok(
        !/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX)\b/i.test(additions),
        `MIGRATION_LOCATION_INVALID: schema changes belong in server/infrastructure/sqlite`,
      );
    }
    changes.push({ commit, path, migration, diffSha256: hash(diff) });
  }
}
assert.equal(
  plan.changes.length,
  changes.length,
  "Migration notes do not match the entire commit range",
);
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;
for (const key of Object.keys(environment))
  if (
    key.startsWith("DAILY_") ||
    key.toLowerCase() === "npm_config_allow_scripts"
  )
    delete environment[key];
const run = (cwd, command, ...args) =>
  execFileSync(command, args, {
    cwd,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
const directory = await mkdtemp(resolve(tmpdir(), "daily-candidate-"));
try {
  const source = resolve(directory, "source"),
    runtime = resolve(directory, "candidate");
  await mkdir(source);
  await mkdir(runtime);
  run(
    repository,
    "git",
    "archive",
    "--format=tar",
    `--output=${resolve(directory, "source.tar")}`,
    from,
  );
  run(source, "tar", "-xf", resolve(directory, "source.tar"));
  run(source, process.execPath, npmCli, "ci");
  run(source, process.execPath, npmCli, "run", "build:server");
  // Runtime archives are trusted CI outputs; reject unexpected top-level paths before extraction.
  const paths = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    windowsHide: true,
  })
    .split(/\r?\n/)
    .filter(Boolean);
  assert.ok(
    paths.every(
      (path) =>
        !path.startsWith("/") &&
        !path.split("/").includes("..") &&
        /^(build\/|dist\/|node_modules\/|package\.json$|package-lock\.json$|release\.json$)/.test(
          path,
        ),
    ),
    "Invalid runtime archive paths",
  );
  run(runtime, "tar", "-xzf", archive);
  const manifest = JSON.parse(
    await readFile(resolve(runtime, "release.json"), "utf8"),
  );
  assert.equal(manifest.commit, to);
  const verifier = resolve(app, "scripts/verify-upgrade.mjs");
  // Actual production baseline first; then retain the original pre-MCP historical baseline.
  run(
    app,
    process.execPath,
    "--import",
    "tsx",
    verifier,
    "--from-runtime",
    source,
    "--candidate-runtime",
    runtime,
  );
  run(
    app,
    process.execPath,
    "--import",
    "tsx",
    verifier,
    "--candidate-runtime",
    runtime,
  );
  await writeFile(
    resolve(options["--output"]),
    JSON.stringify(
      {
        schema: 1,
        from,
        to,
        artifactSha256: receipt.sha256,
        planSha256: hash(planBytes),
        verifierSha256: hash(await readFile(verifier)),
        verifiedAt: new Date().toISOString(),
        changes,
        upgradeVerified: true,
        deployable: false,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(`Upgrade and matched restore verified: ${from} -> ${to}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
