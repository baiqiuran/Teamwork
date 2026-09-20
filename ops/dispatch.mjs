// This short-lived SSH entry submits work to systemd; observing it is optional.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { intent } from "./intent.mjs";
import { report } from "./offsite.mjs";
import { configuration, command, exists } from "./host.mjs";
import { json, durable } from "./io.mjs";

const args = process.argv.slice(2);
assert.equal(args.shift(), "--config");
const configPath = resolve(args.shift());
const config = await configuration(configPath);
const action = args.shift();
assert.ok(
  ["release", "backup", "restore", "inspect", "resolve-incident"].includes(
    action,
  ),
);
const options = {};
while (args.length) {
  const key = args.shift();
  assert.ok(
    [
      "--id",
      "--candidate",
      "--baseline",
      "--kind",
      "--snapshot",
      "--incident",
      "--expected-commit",
      "--note",
    ].includes(key) &&
      args.length &&
      !Object.hasOwn(options, key),
    "INVALID_OPTION",
  );
  options[key] = args.shift();
}
const id = options["--id"] ?? randomUUID();
assert.match(id, /^[a-zA-Z0-9_-]{1,80}$/);
options["--id"] = id;
if (action === "release") {
  assert.match(options["--baseline"] ?? "", /^[a-f0-9]{40}$/);
  assert.ok(options["--candidate"]);
  options["--candidate"] = resolve(options["--candidate"]);
}
const invocation = [
  action,
  ...Object.keys(options)
    .sort()
    .flatMap((key) => [key, options[key]]),
];
const { fingerprint, materials: candidate } = await intent(action, options);
const path = resolve(config.stateDir, "requests", `${id}.json`);
await mkdir(resolve(config.stateDir, "requests"), {
  recursive: true,
  mode: 0o700,
});
// OS lock is released even when the SSH process disappears during submission.
const childArgs = ["--config", configPath, ...invocation];
if (!process.env.DAILY_DISPATCH_LOCKED) {
  try {
    const output = command(
      "/usr/bin/flock",
      "--nonblock",
      resolve(config.stateDir, "dispatch.gate"),
      "/usr/bin/env",
      "DAILY_DISPATCH_LOCKED=1",
      process.execPath,
      fileURLToPath(import.meta.url),
      ...childArgs,
    );
    process.stdout.write(output);
  } catch (error) {
    if (error.stdout) process.stdout.write(String(error.stdout));
    process.exitCode = error.status ?? 1;
  }
} else {
  if (await exists(path)) {
    const prior = await json(path);
    assert.equal(prior.fingerprint, fingerprint, "OPERATION_ID_CONFLICT");
  } else {
    await durable(path, {
      id,
      fingerprint,
      args: childArgs,
      candidate,
      unit: `daily-flow-operation-${id}.service`,
      createdAt: new Date().toISOString(),
    });
  }
  const state = resolve(config.stateDir, "operations", `${id}.json`);
  if (await exists(state)) {
    const record = await json(state);
    assert.equal(record.fingerprint, fingerprint, "OPERATION_ID_CONFLICT");
    console.log(JSON.stringify(await report(config, record)));
    if (record.phase === "failed") process.exitCode = 1;
  } else if (
    await exists(resolve(config.stateDir, "requests", `${id}.result.json`))
  ) {
    console.log(
      JSON.stringify(
        await json(resolve(config.stateDir, "requests", `${id}.result.json`)),
      ),
    );
    process.exitCode = 1;
  } else {
    const unit = `daily-flow-operation-${id}.service`;
    const active = command(
      "/bin/systemctl",
      "show",
      unit,
      "--property=ActiveState",
      "--value",
    ).trim();
    if (!["active", "activating"].includes(active)) {
      command(
        "/usr/bin/systemd-run",
        "--quiet",
        "--no-block",
        `--unit=${unit}`,
        "--property=Type=exec",
        "--property=KillMode=control-group",
        "--property=Restart=no",
        "--property=UMask=0077",
        "--property=TimeoutStopSec=35",
        process.execPath,
        fileURLToPath(new URL("./run-request.mjs", import.meta.url)),
        configPath,
        id,
      );
    }
    console.log(JSON.stringify({ id, phase: "accepted", unit }));
  }
}
