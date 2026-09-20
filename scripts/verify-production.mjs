import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = resolve(tmpdir());
const directory = await mkdtemp(resolve(temporaryRoot, "daily-production-"));
const source = resolve(directory, "source"),
  runtime = resolve(directory, "runtime");
const npm =
  process.env.npm_execpath ??
  resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
async function command(cwd, ...args) {
  const environment = {
    ...process.env,
    PLAYWRIGHT_CHANNEL: process.env.PLAYWRIGHT_CHANNEL ?? "chromium",
  };
  // npm 12 exports this config during npm run, then rejects it as an install flag.
  // Let each isolated install read the original config file instead.
  for (const key of Object.keys(environment))
    if (key.toLowerCase() === "npm_config_allow_scripts")
      delete environment[key];
  const invocation = spawn(process.execPath, [npm, ...args], {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    env: environment,
  });
  const [code] = await once(invocation, "exit");
  assert.equal(code, 0, `npm ${args.join(" ")} failed`);
}
try {
  await mkdir(source);
  // Git supplies source paths only; copy the actual working files, never user data.
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: app,
      encoding: "utf8",
      windowsHide: true,
    },
  )
    .split("\0")
    .filter(Boolean);
  for (const name of new Set(files)) {
    const from = resolve(app, name),
      to = resolve(source, name);
    assert.ok(from.startsWith(app + sep) && to.startsWith(source + sep));
    await mkdir(dirname(to), { recursive: true });
    try {
      await cp(from, to);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await command(source, "ci");
  await command(source, "test");
  // A separate sibling directory prevents fallback to development node_modules.
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
  await command(runtime, "ci", "--omit=dev");
  const smoke = spawn(
    process.execPath,
    [resolve(app, "scripts/verify-runtime.mjs"), runtime],
    { stdio: "inherit", windowsHide: true },
  );
  const [code] = await once(smoke, "exit");
  assert.equal(code, 0, "Production runtime verification failed");
} finally {
  const checked = resolve(directory);
  if (!checked.startsWith(temporaryRoot + sep + "daily-production-"))
    throw new Error("Unexpected temporary directory");
  await rm(checked, { recursive: true, force: true });
}
