import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  buildManualArtifact,
  assertPureJavaScript,
} from "./manual-artifact.mjs";
import { startupPreflight } from "./manual-preflight.mjs";

// A real committed application using HTTP and a disposable SQLite database.
// A forbidden test:ci and production install hook make accidental gates visible.
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "manual-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = resolve(root, "repository");
  await mkdir(repository);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  const pkg = {
    name: "manual-fixture",
    version: "1.0.0",
    type: "module",
    scripts: {
      build: "node build.mjs",
      "test:ci": 'node -e "process.exit(91)"',
      postinstall:
        "node -e \"if(process.env.NODE_ENV==='production')process.exit(92)\"",
    },
  };
  await writeFile(resolve(repository, "package.json"), JSON.stringify(pkg));
  await writeFile(
    resolve(repository, "package-lock.json"),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      packages: { "": { ...pkg, hasInstallScript: true } },
    }),
  );
  await writeFile(
    resolve(repository, "build.mjs"),
    `
    import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
    if (process.env.DAILY_HEALTH_TOKEN || process.env.AWS_SECRET_ACCESS_KEY || process.env.NODE_OPTIONS) process.exit(93);
    mkdirSync('build/server', { recursive: true }); mkdirSync('dist');
    copyFileSync('app.mjs', 'build/server/main.js'); writeFileSync('dist/index.html', 'fixed source');
  `,
  );
  await writeFile(
    resolve(repository, "app.mjs"),
    `
    import { createServer } from 'node:http';
    import { readFileSync, existsSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    if (process.env.AWS_SECRET_ACCESS_KEY || process.env.DAILY_PUBLIC_URL || existsSync(process.env.DAILY_DATABASE_PATH)) process.exit(94);
    const db = new DatabaseSync(process.env.DAILY_DATABASE_PATH);
    db.exec('CREATE TABLE fresh(id INTEGER); PRAGMA user_version=7');
    const version = JSON.parse(readFileSync('release.json')).commit;
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || !['/health/ready', '/internal/health'].includes(req.url)) { res.writeHead(405); res.end(); return; }
      const deep = req.url === '/internal/health';
      if (deep && req.headers['x-daily-health'] !== process.env.DAILY_HEALTH_TOKEN) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ready: true, version, ...(deep ? { schema: db.prepare('PRAGMA user_version').get().user_version, integrity: 'ok', initialized: false, attachmentsAccessible: true } : {}) }));
    }).listen(Number(process.env.PORT), '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => { db.close(); process.exit(0); }));
  `,
  );
  git("add", "package.json", "package-lock.json", "build.mjs", "app.mjs");
  git("commit", "-m", "fixture source");
  return { root, repository, git, commit: git("rev-parse", "HEAD") };
}

test("manual artifact builds fixed source and ships the exact startup-verified receipt contract", async (t) => {
  const { root, repository, commit } = await fixture(t);
  await writeFile(resolve(repository, "app.mjs"), "process.exit(95)");
  const output = resolve(root, "output");
  const poisoned = {
    DAILY_HEALTH_TOKEN: "must-not-leak",
    DAILY_PUBLIC_URL: "https://production.invalid",
    AWS_SECRET_ACCESS_KEY: "must-not-leak",
    NODE_OPTIONS: "--require=must-not-load",
  };
  const previous = Object.fromEntries(
    Object.keys(poisoned).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, poisoned);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const result = await buildManualArtifact({
    repository,
    commit,
    baseline: commit,
    runtimeNode: process.execPath,
    node: process.version,
    migration: { paths: [], confirmed: false },
    output,
  });
  const receipt = JSON.parse(
    await readFile(resolve(output, "receipt.json"), "utf8"),
  );
  assert.deepEqual(
    Object.keys(receipt).sort(),
    [
      "schema",
      "mode",
      "commit",
      "baseline",
      "node",
      "platform",
      "architecture",
      "sha256",
      "expectedSchema",
      "checks",
      "migration",
      "builtAt",
    ].sort(),
  );
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.mode, "manual");
  assert.equal(receipt.commit, commit);
  assert.equal(receipt.baseline, commit);
  assert.equal(receipt.node, process.version);
  assert.equal(receipt.platform, "linux");
  assert.equal(receipt.architecture, "x64");
  assert.equal(receipt.expectedSchema, 7);
  assert.deepEqual(receipt.checks, [
    "architecture",
    "types",
    "build",
    "production-startup",
  ]);
  assert.deepEqual(receipt.migration, { paths: [], confirmed: false });
  assert.equal(
    receipt.sha256,
    createHash("sha256")
      .update(await readFile(resolve(output, "application.tar.gz")))
      .digest("hex"),
  );
  const tar = (...args) =>
    execFileSync("tar", args, {
      cwd: output,
      encoding: "utf8",
      windowsHide: true,
    });
  const { sha256, ...manifest } = receipt;
  assert.deepEqual(
    JSON.parse(tar("-xOzf", "application.tar.gz", "release.json")),
    manifest,
  );
  assert.equal(
    tar("-xOzf", "application.tar.gz", "dist/index.html"),
    "fixed source",
  );
  assert.deepEqual(tar("-tzf", "bundle.tar.gz").trim().split(/\r?\n/).sort(), [
    "application.tar.gz",
    "receipt.json",
  ]);
  assert.equal(
    result.bundleSha256,
    createHash("sha256")
      .update(await readFile(resolve(output, "bundle.tar.gz")))
      .digest("hex"),
  );
  const rebuilt = await buildManualArtifact({
    repository,
    commit,
    baseline: commit,
    runtimeNode: process.execPath,
    node: process.version,
    migration: { paths: [], confirmed: false },
    output: resolve(root, "rebuilt"),
  });
  assert.equal(
    rebuilt.receipt.sha256,
    receipt.sha256,
    "same committed source and recorded inputs must reproduce archive bytes",
  );
  assert.equal(rebuilt.bundleSha256, result.bundleSha256);
});

test("production startup refuses wrong identity, broken deep health and exited processes", async (t) => {
  const runtime = await mkdtemp(resolve(tmpdir(), "manual-health-"));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  await mkdir(resolve(runtime, "build/server"), { recursive: true });
  await writeFile(resolve(runtime, "package.json"), '{"type":"module"}');
  const commit = "a".repeat(40);
  for (const [detail, error] of [
    [{ version: "b".repeat(40) }, /STARTUP_VERSION_MISMATCH/],
    [{ integrity: "broken" }, /STARTUP_HEALTH_FAILED/],
    [{ schema: "7" }, /STARTUP_HEALTH_FAILED/],
    [{ initialized: true }, /STARTUP_HEALTH_FAILED/],
    [{ attachmentsAccessible: false }, /STARTUP_HEALTH_FAILED/],
  ]) {
    const health = {
      ready: true,
      version: commit,
      schema: 7,
      integrity: "ok",
      initialized: false,
      attachmentsAccessible: true,
      ...detail,
    };
    await writeFile(
      resolve(runtime, "build/server/main.js"),
      `import {createServer} from 'node:http'; createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(${JSON.stringify(health)}));}).listen(Number(process.env.PORT),'127.0.0.1');`,
    );
    await assert.rejects(
      startupPreflight({
        runtime,
        runtimeNode: process.execPath,
        node: process.version,
        commit,
        timeoutMs: 5000,
      }),
      error,
    );
  }
  await writeFile(resolve(runtime, "build/server/main.js"), "process.exit(1)");
  await assert.rejects(
    startupPreflight({
      runtime,
      runtimeNode: process.execPath,
      node: process.version,
      commit,
      timeoutMs: 5000,
    }),
    /STARTUP_FAILED/,
  );
  await assert.rejects(
    startupPreflight({
      runtime,
      runtimeNode: process.execPath,
      node: "v0.0.0",
      commit,
    }),
    /NODE_VERSION_MISMATCH/,
  );
});

test("native runtime dependencies cannot be labelled cross-platform pure JavaScript", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "manual-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, "addon.node"), "native bytes");
  await assert.rejects(assertPureJavaScript(root), /NATIVE_RUNTIME_DEPENDENCY/);
});
