import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

test("a failed fixed-commit check cannot publish a release receipt", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "daily-artifact-test-"));
  try {
    const repository = resolve(root, "repository");
    await mkdir(repository);
    const git = (...args) =>
      execFileSync("git", args, { cwd: repository, encoding: "utf8" });
    git("init");
    git("config", "user.email", "fixture@example.test");
    git("config", "user.name", "Fixture");
    await writeFile(
      resolve(repository, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        scripts: {
          "test:ci":
            "node -e \"console.error('EXPECTED_CHECK_FAILURE');process.exit(1)\"",
        },
      }),
    );
    await writeFile(
      resolve(repository, "package-lock.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: { "": { name: "fixture", version: "1.0.0" } },
      }),
    );
    git("add", ".");
    git("commit", "-m", "fixture");
    const commit = git("rev-parse", "HEAD").trim();
    // An uncommitted replacement must not turn the failing committed check green.
    await writeFile(
      resolve(repository, "package.json"),
      JSON.stringify({ scripts: { "test:ci": 'node -e "process.exit(0)"' } }),
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/release-artifact.mjs"),
        "build",
        "--repository",
        repository,
        "--commit",
        commit,
        "--output",
        resolve(root, "release"),
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /EXPECTED_CHECK_FAILURE/);
    await assert.rejects(access(resolve(root, "release/receipt.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
