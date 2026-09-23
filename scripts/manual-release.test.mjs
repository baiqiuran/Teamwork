import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { fileSha256 } from "./manual-artifact.mjs";
import {
  loadManualConfig,
  sshArguments,
  resumeSavedRelease,
  runManualRelease,
  captureBaseline,
} from "./manual-release.mjs";

const cli = fileURLToPath(new URL("manual-release.mjs", import.meta.url));
test("CLI help is offline and documents capture, package, release, resume and matching local Node", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  for (const word of [
    "--config",
    "--capture-baseline",
    "--package-only",
    "--package",
    "--resume",
    "runtimeNode",
    "Windows",
    "knownHosts",
    "baselineRecord",
  ])
    assert.ok(result.stdout.includes(word), word);
  const invalid = spawnSync(
    process.execPath,
    [cli, "--resume", "bad;command"],
    { encoding: "utf8" },
  );
  assert.notEqual(invalid.status, 0);
  const conflicting = spawnSync(
    process.execPath,
    [cli, "--config", "unused", "--package-only", "--package", "one"],
    { encoding: "utf8" },
  );
  assert.match(conflicting.stderr, /USAGE_INVALID/);
});

test("config in the whole workspace is refused without revealing its path", async () => {
  const config = resolve(dirname(cli), "never-read-secret.json");
  await assert.rejects(loadManualConfig(config), (error) => {
    assert.match(error.message, /CONFIG_OUTSIDE_WORKSPACE_REQUIRED/);
    assert.ok(!error.message.includes(config));
    return true;
  });
});

test("SSH pins the provided host file and disables ambient SSH configuration and interactive auth", () => {
  const args = sshArguments(
    {
      host: "example.test",
      user: "release",
      port: 2222,
      identityFile: "C:/private/id",
      knownHosts: "C:/private/known_hosts",
    },
    "manual-status",
    "release-one",
  );
  for (const value of [
    "StrictHostKeyChecking=yes",
    "BatchMode=yes",
    "IdentitiesOnly=yes",
    "UpdateHostKeys=no",
    "ForwardAgent=no",
    "ClearAllForwardings=yes",
  ])
    assert.ok(args.includes(value), value);
  assert.ok(args.includes("UserKnownHostsFile=C:/private/known_hosts"));
  assert.ok(args.includes("-F"));
  assert.equal(args.at(-1), "manual-status release-one");
  assert.throws(() => sshArguments({}, "rm", "/tmp"), /REMOTE_VERB_INVALID/);
});

async function saved(t, phase) {
  const root = await mkdtemp(resolve(tmpdir(), "manual-record-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    outputDir: resolve(root, "output"),
    recordsDir: resolve(root, "records"),
    baselineRecord: resolve(root, "baseline.json"),
    target: {
      host: "fixture.test",
      user: "release",
      port: 22,
      hostKeysSha256: "e".repeat(64),
    },
  };
  const id = "manual-fixture";
  const output = resolve(config.outputDir, id);
  await mkdir(output, { recursive: true });
  await mkdir(config.recordsDir);
  await writeFile(
    resolve(output, "application.tar.gz"),
    "immutable application fixture",
  );
  const receipt = {
    schema: 1,
    mode: "manual",
    commit: "b".repeat(40),
    baseline: "a".repeat(40),
    node: process.version,
    platform: "linux",
    architecture: "x64",
    expectedSchema: 7,
    checks: ["architecture", "types", "build", "production-startup"],
    migration: { paths: [], confirmed: false },
    builtAt: "2026-09-22T00:00:00.000Z",
    sha256: await fileSha256(resolve(output, "application.tar.gz")),
  };
  await writeFile(resolve(output, "receipt.json"), JSON.stringify(receipt));
  execFileSync(
    "tar",
    ["-czf", "bundle.tar.gz", "application.tar.gz", "receipt.json"],
    { cwd: output, windowsHide: true },
  );
  const bundleSha256 = await fileSha256(resolve(output, "bundle.tar.gz"));
  const file = resolve(config.recordsDir, `${id}.json`);
  await writeFile(
    file,
    JSON.stringify({
      schema: 1,
      id,
      target: config.target,
      receipt,
      bundleSha256,
      createdAt: receipt.builtAt,
      server: null,
    }),
  );
  const status = {
    id,
    phase,
    commit: receipt.commit,
    baseline: receipt.baseline,
    bundleSha256,
    artifactSha256: receipt.sha256,
    expectedSchema: 7,
    actualCommit: receipt.commit,
    criteria: {
      processActive: true,
      ready: true,
      version: receipt.commit,
      schema: 7,
      integrity: "ok",
      attachmentsAccessible: true,
      readOnlyPage: true,
      errorResponses: { errors: 0, requests: 1 },
    },
    snapshotId: "snapshot-one",
    maintenanceMilliseconds: 1250,
    maintenanceAt: "2026-09-22T00:00:00.000Z",
    maintenanceEndedAt: "2026-09-22T00:00:01.250Z",
    finishedAt: "2026-09-22T00:00:05.000Z",
  };
  return { root, config, output, id, file, status };
}

test("resume preserves the full completed server record locally without rebuilding or sending release", async (t) => {
  const f = await saved(t, "completed");
  // This adapter is the remote protocol boundary, not a replacement of client internals.
  const gateway = async (verb, id) => {
    assert.equal(verb, "manual-status");
    assert.equal(id, f.id);
    return f.status;
  };
  await resumeSavedRelease({ config: f.config, id: f.id, gateway });
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).server, f.status);
  const baseline = JSON.parse(await readFile(f.config.baselineRecord, "utf8"));
  assert.equal(baseline.source, "manual-release");
  assert.equal(baseline.releaseId, f.id);
  assert.equal(baseline.observation.commit, f.status.commit);
  assert.equal(baseline.observedAt, f.status.finishedAt);
  assert.deepEqual(baseline.target, f.config.target);
});

test("resuming an old completion does not replace a newer baseline observation", async (t) => {
  const f = await saved(t, "completed");
  const newer = {
    schema: 1,
    source: "manual-baseline",
    target: f.config.target,
    observedAt: "2026-09-23T00:00:00.000Z",
    observation: { commit: "c".repeat(40) },
  };
  await writeFile(f.config.baselineRecord, JSON.stringify(newer));
  await resumeSavedRelease({
    config: f.config,
    id: f.id,
    gateway: async () => f.status,
  });
  assert.deepEqual(
    JSON.parse(await readFile(f.config.baselineRecord, "utf8")),
    newer,
  );
});

test("completed status without matching acceptance evidence cannot advance the baseline", async (t) => {
  for (const patch of [
    { actualCommit: "c".repeat(40) },
    { criteria: { ready: true } },
    { snapshotId: undefined },
    { maintenanceMilliseconds: 180001 },
    { maintenanceEndedAt: undefined },
    { maintenanceMilliseconds: 1249 },
  ]) {
    const f = await saved(t, "completed");
    const original = { observation: { commit: f.status.baseline } };
    await writeFile(f.config.baselineRecord, JSON.stringify(original));
    await assert.rejects(
      resumeSavedRelease({
        config: f.config,
        id: f.id,
        gateway: async () => ({ ...f.status, ...patch }),
      }),
      /REMOTE_ACCEPTANCE_INVALID/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(f.config.baselineRecord, "utf8")),
      original,
    );
  }
});

test("failed or unknown releases are recorded and never automatically resubmitted", async (t) => {
  for (const phase of ["failed", "unknown"]) {
    const f = await saved(t, phase);
    const gateway = async (verb) => {
      assert.equal(verb, "manual-status");
      return f.status;
    };
    await assert.rejects(
      resumeSavedRelease({ config: f.config, id: f.id, gateway }),
      /REMOTE_RELEASE_(FAILED|UNKNOWN)/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(f.file, "utf8")).server,
      f.status,
    );
  }
});

test("live baseline drift stops an absent or uploaded release without upload or release", async (t) => {
  for (const phase of ["absent", "uploaded"]) {
    const f = await saved(t, phase);
    const gateway = async (verb) => {
      if (verb === "manual-status") return f.status;
      assert.equal(verb, "manual-baseline");
      return {
        commit: "c".repeat(40),
        node: process.version,
        platform: "linux",
        architecture: "x64",
        busy: false,
        frozen: false,
        maintenance: false,
      };
    };
    await assert.rejects(
      resumeSavedRelease({ config: f.config, id: f.id, gateway }),
      /LIVE_BASELINE_CHANGED/,
    );
  }
});

test("lost upload acknowledgement keeps the stable ID, then resume submits only the already uploaded bundle", async (t) => {
  const f = await saved(t, "absent");
  const live = {
    commit: f.status.baseline,
    node: process.version,
    platform: "linux",
    architecture: "x64",
    busy: false,
    frozen: false,
    maintenance: false,
  };
  let uploaded = false;
  await assert.rejects(
    resumeSavedRelease({
      config: f.config,
      id: f.id,
      gateway: async (verb, id, digest, { bundle } = {}) => {
        if (verb === "manual-status") return f.status;
        if (verb === "manual-baseline") return live;
        assert.equal(verb, "manual-upload");
        assert.equal(id, f.id);
        assert.equal(digest, await fileSha256(bundle));
        assert.equal(
          JSON.parse(await readFile(f.file, "utf8")).bundleSha256,
          digest,
          "ID/digest must already be durable before upload",
        );
        uploaded = true;
        throw new Error("REMOTE_CONNECTION_LOST");
      },
    }),
    (error) =>
      error.resumeId === f.id && /REMOTE_CONNECTION_LOST/.test(error.message),
  );
  assert.equal(uploaded, true);
  let submitted = false;
  const result = await resumeSavedRelease({
    config: f.config,
    id: f.id,
    gateway: async (verb, id, baseline) => {
      if (verb === "manual-status") return { ...f.status, phase: "uploaded" };
      if (verb === "manual-baseline") return live;
      assert.equal(verb, "manual-release");
      assert.equal(id, f.id);
      assert.equal(baseline, live.commit);
      assert.equal(submitted, false);
      submitted = true;
      return { ...f.status, phase: "completed" };
    },
  });
  assert.equal(result.phase, "completed");
});

test("pending jobs stop at the observation bound and local write failure never reports success", async (t) => {
  const pending = await saved(t, "running");
  await assert.rejects(
    resumeSavedRelease({
      config: pending.config,
      id: pending.id,
      maxWaitMs: 0,
      gateway: async (verb) => {
        assert.equal(verb, "manual-status");
        return pending.status;
      },
    }),
    /REMOTE_RELEASE_PENDING/,
  );
  assert.equal(
    JSON.parse(await readFile(pending.file, "utf8")).server.phase,
    "running",
  );
  const f = await saved(t, "completed");
  await assert.rejects(
    resumeSavedRelease({
      config: f.config,
      id: f.id,
      gateway: async (verb) => {
        assert.equal(verb, "manual-status");
        await rm(f.file);
        await mkdir(f.file);
        return f.status;
      },
    }),
    /LOCAL_RECORD_WRITE_FAILED/,
  );
});

test("resume refuses altered bundle bytes before any network request", async (t) => {
  const f = await saved(t, "uploaded");
  await writeFile(resolve(f.output, "bundle.tar.gz"), "changed");
  await assert.rejects(
    resumeSavedRelease({
      config: f.config,
      id: f.id,
      gateway: () => assert.fail("no server request"),
    }),
    /LOCAL_BUNDLE_MISMATCH/,
  );
});

test("a recorded failure cannot be replayed even if the server later loses its record", async (t) => {
  const f = await saved(t, "failed");
  await assert.rejects(
    resumeSavedRelease({
      config: f.config,
      id: f.id,
      gateway: async () => f.status,
    }),
    /REMOTE_RELEASE_FAILED/,
  );
  await assert.rejects(
    resumeSavedRelease({
      config: f.config,
      id: f.id,
      gateway: async (verb) => {
        assert.equal(verb, "manual-status");
        return { id: f.id, phase: "absent" };
      },
    }),
    /REMOTE_RELEASE_FAILED/,
  );
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).server, f.status);
});

async function localReleaseFixture(t, { runnable = false } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "manual-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, "workspace"),
    repository = resolve(workspace, "app");
  await mkdir(repository, { recursive: true });
  // Synthetic format-only envelope: deliberately NOT usable key material, and
  // no key generation, agent mutation, permission changes or SSH connections.
  const field = (bytes) => {
    const b = Buffer.from(bytes);
    const n = Buffer.alloc(4);
    n.writeUInt32BE(b.length);
    return Buffer.concat([n, b]);
  };
  const pub = Buffer.concat([field("ssh-ed25519"), field(Buffer.alloc(32, 1))]);
  const envelope = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    field("aes256-ctr"),
    field("bcrypt"),
    field(
      Buffer.concat([field(Buffer.alloc(16, 2)), Buffer.from([0, 0, 0, 16])]),
    ),
    Buffer.from([0, 0, 0, 1]),
    field(pub),
    field(Buffer.alloc(160, 3)),
  ]);
  const config = {
    host: "fixture.invalid",
    user: "release",
    port: 22,
    identityFile: resolve(root, "synthetic-envelope"),
    knownHosts: resolve(root, "known_hosts"),
    runtimeNode: process.execPath,
    baselineRecord: resolve(root, "baseline.json"),
    outputDir: resolve(root, "output"),
    recordsDir: resolve(root, "records"),
  };
  await writeFile(
    config.identityFile,
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${envelope.toString("base64")}\n-----END OPENSSH PRIVATE KEY-----\n`,
  );
  await writeFile(
    config.knownHosts,
    `fixture.invalid ssh-ed25519 ${pub.toString("base64")}\n`,
  );
  const configPath = resolve(root, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    }).trim();
  git("init", "-b", "main");
  const pkg = {
    name: "fixture",
    version: "1.0.0",
    type: "module",
    scripts: {
      build: runnable ? "node build.mjs" : 'node -e "process.exit(73)"',
    },
  };
  await writeFile(resolve(repository, "package.json"), JSON.stringify(pkg));
  await writeFile(
    resolve(repository, "package-lock.json"),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      packages: { "": pkg },
    }),
  );
  if (runnable) {
    await writeFile(
      resolve(repository, "build.mjs"),
      `import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
       mkdirSync('build/server', { recursive: true });
       mkdirSync('dist');
       copyFileSync('app.mjs', 'build/server/main.js');
       writeFileSync('dist/index.html', '<html>fixture</html>');`,
    );
    await writeFile(
      resolve(repository, "app.mjs"),
      `import { createServer } from 'node:http';
       import { readFileSync } from 'node:fs';
       import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(process.env.DAILY_DATABASE_PATH);
       db.exec('CREATE TABLE fresh(id INTEGER); PRAGMA user_version=7');
       const version = JSON.parse(readFileSync('release.json')).commit;
       const server = createServer((request, response) => {
         if (request.method !== 'GET' || !['/health/ready', '/internal/health'].includes(request.url)) {
           response.writeHead(405); response.end(); return;
         }
         const deep = request.url === '/internal/health';
         if (deep && request.headers['x-daily-health'] !== process.env.DAILY_HEALTH_TOKEN) {
           response.writeHead(404); response.end(); return;
         }
         response.setHeader('content-type', 'application/json');
         response.end(JSON.stringify({ ready: true, version, ...(deep ? {
           schema: db.prepare('PRAGMA user_version').get().user_version,
           integrity: 'ok', initialized: false, attachmentsAccessible: true
         } : {}) }));
       }).listen(Number(process.env.PORT), '127.0.0.1');
       process.on('SIGTERM', () => server.close(() => { db.close(); process.exit(0); }));`,
    );
  }
  git("add", ".");
  git("commit", "-m", "fixture baseline");
  const baseline = git("rev-parse", "HEAD");
  const origin = resolve(root, "origin.git");
  git("clone", "--bare", repository, origin);
  git("remote", "add", "origin", origin);
  const loaded = await loadManualConfig(configPath, { workspace });
  const observation = {
    commit: baseline,
    node: process.version,
    platform: "linux",
    architecture: "x64",
    busy: false,
    frozen: false,
    maintenance: false,
  };
  await captureBaseline({
    config: loaded,
    gateway: async (verb) => {
      assert.equal(verb, "manual-baseline");
      return observation;
    },
  });
  return {
    root,
    workspace,
    repository,
    config,
    configPath,
    git,
    baseline,
    origin,
  };
}

test("package-only avoids production and a later release uploads the same saved bundle", async (t) => {
  const f = await localReleaseFixture(t, { runnable: true });
  const steps = [];
  const packaged = await runManualRelease({
    ...f,
    packageOnly: true,
    gateway: () => assert.fail("packaging must not contact production"),
    onStep: (step) => steps.push(step),
  });
  assert.ok(packaged.id.startsWith("manual-"));
  assert.ok(steps.some((step) => step.includes(packaged.bundleSha256)));
  assert.equal(await fileSha256(packaged.bundle), packaged.bundleSha256);
  const record = JSON.parse(
    await readFile(resolve(f.config.recordsDir, `${packaged.id}.json`), "utf8"),
  );
  assert.equal(record.server, null);
  assert.equal(record.bundleSha256, packaged.bundleSha256);
  assert.equal(record.receipt.commit, f.baseline);
  await writeFile(
    resolve(f.repository, "app.mjs"),
    "throw new Error('changed')",
  );

  let uploaded = false;
  const staleGateway = async (verb, id) => {
    if (verb === "manual-status") {
      assert.equal(id, packaged.id);
      return { id, phase: "absent" };
    }
    assert.equal(verb, "manual-baseline");
    return {
      commit: "c".repeat(40),
      node: process.version,
      platform: "linux",
      architecture: "x64",
      busy: false,
      frozen: false,
      maintenance: false,
    };
  };
  await assert.rejects(
    runManualRelease({
      ...f,
      packageId: packaged.id,
      gateway: staleGateway,
      onStep: () => {},
    }),
    /LIVE_BASELINE_CHANGED/,
  );
  assert.equal(uploaded, false);

  const identity = {
    id: packaged.id,
    commit: record.receipt.commit,
    baseline: record.receipt.baseline,
    bundleSha256: packaged.bundleSha256,
    artifactSha256: record.receipt.sha256,
    expectedSchema: record.receipt.expectedSchema,
  };
  const gateway = async (verb, id, value, { bundle } = {}) => {
    if (verb === "manual-status") return { id, phase: "absent" };
    if (verb === "manual-baseline")
      return {
        commit: f.baseline,
        node: process.version,
        platform: "linux",
        architecture: "x64",
        busy: false,
        frozen: false,
        maintenance: false,
      };
    assert.equal(id, packaged.id);
    if (verb === "manual-upload") {
      assert.equal(value, packaged.bundleSha256);
      assert.equal(await fileSha256(bundle), packaged.bundleSha256);
      uploaded = true;
      return { ...identity, phase: "uploaded" };
    }
    assert.equal(verb, "manual-release");
    assert.equal(value, f.baseline);
    assert.equal(uploaded, true);
    const at = Date.now();
    return {
      ...identity,
      phase: "completed",
      actualCommit: identity.commit,
      criteria: {
        processActive: true,
        ready: true,
        version: identity.commit,
        schema: identity.expectedSchema,
        integrity: "ok",
        attachmentsAccessible: true,
        readOnlyPage: true,
        errorResponses: { errors: 0, requests: 1 },
      },
      snapshotId: "package-snapshot",
      maintenanceAt: new Date(at).toISOString(),
      maintenanceEndedAt: new Date(at + 1000).toISOString(),
      maintenanceMilliseconds: 1000,
      finishedAt: new Date(at + 2000).toISOString(),
    };
  };
  const result = await runManualRelease({
    ...f,
    packageId: packaged.id,
    gateway,
    onStep: () => {},
  });
  assert.equal(result.phase, "completed");
  assert.equal(uploaded, true);
  assert.equal(await fileSha256(packaged.bundle), packaged.bundleSha256);
  assert.equal(
    JSON.parse(await readFile(f.config.baselineRecord, "utf8")).releaseId,
    packaged.id,
  );
});

test("release uses explicit captured evidence, refreshes the actual origin and fails its build before any SSH", async (t) => {
  const f = await localReleaseFixture(t);
  const observation = JSON.parse(
    await readFile(f.config.baselineRecord, "utf8"),
  );
  assert.equal(observation.source, "manual-baseline");
  assert.equal(observation.observation.commit, f.baseline);
  // No SQLite changes: a noninteractive caller must reach build, without a prompt.
  await assert.rejects(
    runManualRelease({
      ...f,
      gateway: () =>
        assert.fail("no server connection before successful startup"),
      onStep: () => {},
    }),
    /LOCAL_STEP_FAILED: npm run build/,
  );
  await writeFile(resolve(f.repository, "unpushed.txt"), "local only");
  f.git("add", "unpushed.txt");
  f.git("commit", "-m", "unpushed fixture");
  f.git("update-ref", "refs/remotes/origin/main", f.git("rev-parse", "HEAD"));
  await assert.rejects(
    runManualRelease({
      ...f,
      gateway: () => assert.fail("no server request"),
      onStep: () => {},
    }),
    /HEAD_NOT_PUSHED/,
  );
});

test("missing private-key files produce a sanitized config error, not an operating-system path leak", async (t) => {
  const f = await localReleaseFixture(t);
  const secretPath = resolve(f.root, "sensitive-key-location");
  await writeFile(
    f.configPath,
    JSON.stringify({ ...f.config, identityFile: secretPath }),
  );
  await assert.rejects(
    loadManualConfig(f.configPath, { workspace: f.workspace }),
    (error) => {
      assert.ok(!error.message.includes(secretPath));
      assert.match(error.message, /CONFIG_INVALID/);
      return true;
    },
  );
});

test("SQLite history changes refuse noninteractive release before build or SSH", async (t) => {
  const f = await localReleaseFixture(t);
  await mkdir(resolve(f.repository, "server/infrastructure/sqlite"), {
    recursive: true,
  });
  await writeFile(
    resolve(f.repository, "server/infrastructure/sqlite/migration.ts"),
    "change",
  );
  f.git("add", "server/infrastructure/sqlite/migration.ts");
  f.git("commit", "-m", "fixture migration");
  // Update the fixture-only bare origin without pushing any real repository.
  execFileSync(
    "git",
    ["--git-dir", f.origin, "fetch", f.repository, "main:main"],
    { windowsHide: true, stdio: "pipe" },
  );
  await assert.rejects(
    runManualRelease({
      ...f,
      gateway: () => assert.fail("no server request"),
      onStep: () => {},
    }),
    /MIGRATION_CONFIRMATION_REQUIRED/,
  );
});
