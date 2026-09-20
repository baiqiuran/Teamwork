import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

test("a changed production baseline requires new upgrade evidence before reading the candidate", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts/verify-candidate.mjs"),
      "--from",
      "1".repeat(40),
      "--current",
      "2".repeat(40),
      "--artifact",
      "missing-candidate",
      "--plan",
      "missing-plan",
      "--output",
      "build/invalid-evidence.json",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BASELINE_CHANGED/);
});

test("destructive migration SQL and missing explanations block before runtime preparation", async () => {
  for (const sql of [
    "db.exec(`DELETE\nFROM diaries`);",
    'db.exec(\'UPDATE "diaries" SET draft=""\');',
    'db.exec("DROP TABLE diaries");',
  ]) {
    const result = await migrationAttempt(
      "server/infrastructure/sqlite/database.ts",
      sql,
      "additive",
    );
    assert.match(result.stderr, /DESTRUCTIVE_MIGRATION/);
  }
  const missing = await migrationAttempt(
    "server/infrastructure/sqlite/database.ts",
    'db.exec("ALTER TABLE diaries ADD COLUMN note TEXT");',
    undefined,
  );
  assert.match(missing.stderr, /MIGRATION_NOTES_MISSING/);
});

test("ordinary repository UPDATE reaches compatibility validation instead of being rejected as a migration", async () => {
  const result = await migrationAttempt(
    "server/modules/sharing/infrastructure/sqlite/sharing-repository.ts",
    'export function close(db) { db.prepare(\'UPDATE "shares" SET closed_at=? WHERE id=?\').run(1, "fixture"); }',
    "runtime",
  );
  assert.match(result.stderr, /EXPECTED_SOURCE_BUILD_BOUNDARY/);
  assert.doesNotMatch(result.stderr, /DESTRUCTIVE_MIGRATION/);
});

async function migrationAttempt(path, sql, kind) {
  const root = await mkdtemp(resolve(tmpdir(), "daily-candidate-test-"));
  try {
    const git = (...args) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init");
    git("config", "user.email", "fixture@example.test");
    git("config", "user.name", "Fixture");
    await mkdir(resolve(root, path, ".."), { recursive: true });
    await writeFile(resolve(root, path), "// unchanged implementation\n");
    await writeFile(
      resolve(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        scripts: {
          "build:server":
            "node -e \"console.error('EXPECTED_SOURCE_BUILD_BOUNDARY');process.exit(1)\"",
        },
      }),
    );
    await writeFile(
      resolve(root, "package-lock.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: { "": { name: "fixture", version: "1.0.0" } },
      }),
    );
    git("add", ".");
    git("commit", "-m", "source");
    const from = git("rev-parse", "HEAD");
    await writeFile(resolve(root, path), sql + "\n");
    git("add", ".");
    git("commit", "-m", "candidate");
    const to = git("rev-parse", "HEAD");
    const artifact = resolve(root, "artifact");
    await mkdir(artifact);
    const archive = Buffer.from(
      "Fixture stops at migration validation or source runtime preparation",
    );
    await writeFile(resolve(artifact, "application.tar.gz"), archive);
    await writeFile(
      resolve(artifact, "receipt.json"),
      JSON.stringify({
        schema: 1,
        commit: to,
        sha256: createHash("sha256").update(archive).digest("hex"),
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        checks: [
          "architecture",
          "types",
          "build",
          "api",
          "browser",
          "production-runtime",
        ],
      }),
    );
    const plan = resolve(root, "plan.json"),
      output = resolve(root, "evidence.json");
    await writeFile(
      plan,
      JSON.stringify({
        from,
        to,
        automatic: true,
        description: "Fixture change",
        changes: kind
          ? [{ commit: to, path, kind, description: "Change explanation" }]
          : [],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/verify-candidate.mjs"),
        "--repository",
        root,
        "--from",
        from,
        "--current",
        from,
        "--artifact",
        artifact,
        "--plan",
        plan,
        "--output",
        output,
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.notEqual(result.status, 0);
    await assert.rejects(access(output));
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
