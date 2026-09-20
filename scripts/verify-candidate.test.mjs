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

test("destructive SQL cannot pass by declaring the migration additive; missing notes also block", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "daily-candidate-test-"));
  try {
    const git = (...args) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init");
    git("config", "user.email", "fixture@example.test");
    git("config", "user.name", "Fixture");
    const path = "server/infrastructure/sqlite/database.ts";
    await mkdir(resolve(root, "server/infrastructure/sqlite"), {
      recursive: true,
    });
    await writeFile(resolve(root, path), "// unchanged schema\n");
    git("add", ".");
    git("commit", "-m", "source");
    const from = git("rev-parse", "HEAD");
    await writeFile(resolve(root, path), 'db.exec("DROP TABLE diaries");\n');
    git("add", ".");
    git("commit", "-m", "destructive migration");
    const to = git("rev-parse", "HEAD");
    const artifact = resolve(root, "artifact");
    await mkdir(artifact);
    const archive = Buffer.from(
      "Not extracted: migration gate must reject first",
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
    for (const [changes, expected] of [
      [[], /MIGRATION_NOTES_MISSING/],
      [
        [{ commit: to, path, kind: "additive", description: "Claimed safe" }],
        /DESTRUCTIVE_MIGRATION/,
      ],
    ]) {
      const plan = resolve(root, "plan.json"),
        output = resolve(root, "evidence.json");
      await writeFile(
        plan,
        JSON.stringify({
          from,
          to,
          automatic: true,
          description: "Fixture migration",
          changes,
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
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      await assert.rejects(access(output));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
