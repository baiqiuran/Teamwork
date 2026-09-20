import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
const [candidatePath, temporary] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert.ok(candidatePath && temporary);
const candidate = resolve(candidatePath),
  root = resolve(temporary),
  repository = process.cwd();
const baseline = "4fddcd678f801a5e0f8fc7dd1bd0f9944954f55f";
const run = (command, ...args) =>
  execFileSync(command, args, { stdio: "inherit" });
await mkdir(root, { recursive: true });
run(
  process.execPath,
  "scripts/release-artifact.mjs",
  "build",
  "--commit",
  baseline,
  "--output",
  resolve(root, "baseline"),
);
const commit = JSON.parse(
  await (
    await import("node:fs/promises")
  ).readFile(resolve(candidate, "receipt.json"), "utf8"),
).commit;
run(
  process.execPath,
  "scripts/create-plan.mjs",
  "--from",
  baseline,
  "--to",
  commit,
  "--output",
  resolve(candidate, "plan.json"),
);
run(
  process.execPath,
  "scripts/verify-candidate.mjs",
  "--from",
  baseline,
  "--current",
  baseline,
  "--artifact",
  candidate,
  "--plan",
  resolve(candidate, "plan.json"),
  "--output",
  resolve(candidate, "upgrade.json"),
);
const name = `daily-acceptance-${randomUUID()}`;
run(
  "docker",
  "build",
  "-t",
  "daily-flow-acceptance:local",
  "-f",
  "ops/testing/Dockerfile",
  "ops/testing",
);
try {
  run(
    "docker",
    "run",
    "-d",
    "--name",
    name,
    "--privileged",
    "--cgroupns=private",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/run/lock",
    "--mount",
    `type=bind,source=${repository},target=/repository,readonly`,
    "daily-flow-acceptance:local",
  );
  run("docker", "cp", resolve(root, "baseline"), `${name}:/fixture-artifact`);
  run("docker", "cp", candidate, `${name}:/candidate-artifact`);
  run("docker", "exec", name, "mkdir", "/fixture-runtime");
  run(
    "docker",
    "exec",
    name,
    "tar",
    "-xzf",
    "/fixture-artifact/application.tar.gz",
    "-C",
    "/fixture-runtime",
  );
  const tests = (await readdir("ops/testing"))
    .filter((n) => n.endsWith(".test.mjs"))
    .map((n) => `ops/testing/${n}`);
  run(
    "docker",
    "exec",
    "-w",
    "/repository",
    name,
    "node",
    "--test",
    "--test-concurrency=1",
    ...tests,
  );
} finally {
  run("docker", "rm", "-f", name);
}
