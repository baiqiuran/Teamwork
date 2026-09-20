import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  rename,
} from "node:fs/promises";
import { tmpdir, release } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { npmCli } from "./npm-cli.mjs";

const args = process.argv.slice(2);
assert.equal(
  args.shift(),
  "build",
  "Usage: release-artifact.mjs build --repository PATH --commit FULL_SHA --output NEW_DIRECTORY",
);
const options = {};
while (args.length) {
  const key = args.shift();
  assert.ok(
    ["--repository", "--commit", "--output"].includes(key) && args.length,
    "Unknown or missing option",
  );
  assert.ok(!options[key], "Duplicate option");
  options[key] = args.shift();
}
assert.match(options["--commit"] ?? "", /^[0-9a-f]{40}$/);
assert.ok(options["--output"]);
const repository = resolve(options["--repository"] ?? ".");
const output = resolve(options["--output"]);
const commit = options["--commit"];
assert.equal(
  execFileSync("git", ["cat-file", "-t", commit], {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
  }).trim(),
  "commit",
  "Release identity must be a commit object",
);
const environment = { ...process.env, PLAYWRIGHT_CHANNEL: "chromium" };
delete environment.NODE_TEST_CONTEXT;
for (const key of Object.keys(environment))
  if (
    key.toLowerCase() === "npm_config_allow_scripts" ||
    key.startsWith("DAILY_")
  )
    delete environment[key];
const run = (cwd, command, ...argv) =>
  execFileSync(command, argv, {
    cwd,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
const directory = await mkdtemp(resolve(tmpdir(), "daily-release-"));
try {
  const source = resolve(directory, "source"),
    runtime = resolve(directory, "runtime");
  await mkdir(source);
  run(
    repository,
    "git",
    "archive",
    "--format=tar",
    `--output=${resolve(directory, "source.tar")}`,
    commit,
  );
  run(source, "tar", "-xf", resolve(directory, "source.tar"));
  run(source, process.execPath, npmCli, "ci");
  run(source, process.execPath, npmCli, "run", "test:ci");
  await mkdir(runtime);
  for (const name of [
    "build/server",
    "dist",
    "package.json",
    "package-lock.json",
  ])
    await cp(resolve(source, name), resolve(runtime, name), {
      recursive: true,
    });
  run(runtime, process.execPath, npmCli, "ci", "--omit=dev");
  const manifest = {
    schema: 1,
    commit,
    applicationVersion: JSON.parse(
      await readFile(resolve(source, "package.json"), "utf8"),
    ).version,
    builtAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    os: release(),
    checks: [
      "architecture",
      "types",
      "build",
      "api",
      "browser",
      "production-runtime",
    ],
    migrationVerified: false,
  };
  await writeFile(
    resolve(runtime, "release.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  run(
    repository,
    process.execPath,
    resolve(source, "scripts/verify-runtime.mjs"),
    runtime,
  );
  const archive = resolve(directory, "application.tar.gz");
  run(
    runtime,
    "tar",
    "-czf",
    archive,
    "build",
    "dist",
    "node_modules",
    "package.json",
    "package-lock.json",
    "release.json",
  );
  const sha256 = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  // Never replace an existing artifact/receipt, including on a failed retry.
  await mkdir(output);
  await cp(archive, resolve(output, "application.tar.gz"));
  await writeFile(
    resolve(output, "receipt.json.partial"),
    JSON.stringify(
      {
        ...manifest,
        sha256,
        artifact: "application.tar.gz",
        deployable: false,
      },
      null,
      2,
    ) + "\n",
  );
  await rename(
    resolve(output, "receipt.json.partial"),
    resolve(output, "receipt.json"),
  );
  console.log(
    `Verified artifact ${commit}: ${sha256}; upgrade verification still required.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
