import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  cp,
  symlink,
  chmod,
  truncate,
  realpath,
  stat,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { port, run } from "./fixture.mjs";
import { sshFixture } from "./ssh-fixture.mjs";
import { json, sha256 } from "../io.mjs";
import { processIdentity } from "../process-identity.mjs";
import { runManualRelease } from "../../scripts/manual-release.mjs";

// The public seam is the manual client and pinned, forced-command SSH connection,
// not controller internals. All state/service changes use this disposable fixture.
test("manual SSH controls uploads and detached releases without exposing shell or secrets", async (t) => {
  assert.equal(
    process.platform,
    "linux",
    "Requires the isolated systemd container",
  );
  const id = `daily-manual-ssh-${randomUUID()}`;
  const f = { id, root: `/srv/${id}` };
  const appPort = await port(),
    proxyPort = await port();
  f.config = {
    schema: 1,
    dataDir: `${f.root}/data`,
    database: "daily.sqlite",
    stateDir: `${f.root}/control`,
    backupDir: `${f.root}/backups`,
    current: `${f.root}/current`,
    releases: `${f.root}/releases`,
    envFile: `${f.root}/config.env`,
    artifact: "/fixture-artifact/application.tar.gz",
    unit: `${id}.service`,
    maintenance: `${f.root}/maintenance`,
    dataLock: `${f.root}/data.lock`,
    probeUrl: `http://127.0.0.1:${appPort}/api/setup/status`,
    ingressUrl: `http://127.0.0.1:${proxyPort}`,
    serviceUser: "nobody",
    reserveBytes: 1048576,
    incoming: `${f.root}/incoming`,
    healthTokenFile: `${f.root}/health-token`,
    manualAccessLog: `${f.root}/access.log`,
    automationEnabled: false,
  };
  let succeeded = false,
    ownedAgentPid;
  const previousAgentEnvironment = Object.fromEntries(
    ["SSH_AUTH_SOCK", "SSH_AGENT_PID"].map((key) => [key, process.env[key]]),
  );
  // Register before provisioning, so failed startup also preserves an identified
  // fixture. Never delete unrelated roots or fixtures belonging to other tests.
  t.after(async () => {
    try {
      if (ownedAgentPid) process.kill(ownedAgentPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    } finally {
      // Agent cleanup is unconditional, even when preserving a failed fixture.
      for (const [key, value] of Object.entries(previousAgentEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    if (!succeeded) {
      t.diagnostic(`Preserved failed manual SSH fixture: ${f.root}`);
      return;
    }
    run("systemctl", "stop", f.config.unit);
    await rm(`/etc/nginx/conf.d/${f.id}.conf`, { force: true });
    run("systemctl", "reload", "nginx");
    await rm(`/etc/systemd/system/${f.id}.service`, { force: true });
    run("systemctl", "daemon-reload");
    await rm(`/etc/sudoers.d/${f.id}`, { force: true });
    await rm(`/usr/local/sbin/${f.id}-gateway`, { force: true });
    run("userdel", "deploy" + f.id.slice(-8));
    await rm(f.root, { recursive: true, force: true });
  });
  // Local copy of the base single-instance fixture, with health identity and a
  // bounded readiness wait before setup (the shared fixture assumes 5 seconds).
  await mkdir(f.root);
  for (const directory of [
    "data",
    "control",
    "backups",
    "releases",
    "incoming",
  ])
    await mkdir(`${f.root}/${directory}`, {
      mode: directory === "data" || directory === "releases" ? 0o755 : 0o700,
    });
  await writeFile(f.config.dataLock, "");
  run("chown", "nobody", f.config.dataDir, f.config.dataLock);
  await cp("/fixture-runtime", `${f.config.releases}/initial`, {
    recursive: true,
  });
  await symlink(`${f.config.releases}/initial`, f.config.current);
  const baseline = (await json(`${f.config.current}/release.json`)).commit;
  const token = randomUUID() + randomUUID();
  await writeFile(f.config.healthTokenFile, token, { mode: 0o600 });
  await writeFile(
    f.config.envFile,
    `PORT=${appPort}\nDAILY_DATABASE_PATH=${f.config.dataDir}/daily.sqlite\nDAILY_HEALTH_TOKEN=${token}\n`,
    { mode: 0o600 },
  );
  await writeFile(`${f.root}/deploy.json`, JSON.stringify(f.config), {
    mode: 0o600,
  });
  await writeFile(
    `${f.config.stateDir}/runtime.json`,
    JSON.stringify({ commit: baseline, artifact: f.config.artifact }),
  );
  await writeFile(
    `/etc/systemd/system/${id}.service`,
    `[Unit]\nDescription=Isolated manual SSH fixture\n[Service]\nUser=nobody\nWorkingDirectory=${f.config.current}\nEnvironmentFile=${f.config.envFile}\nExecStart=/usr/bin/flock --nonblock ${f.config.dataLock} /usr/local/bin/node build/server/main.js\nExecStop=/bin/sleep 1\nTimeoutStopSec=30\nKillMode=control-group\n`,
  );
  const format = `manual_${id.slice(-12)}`;
  // escape=json renders an absent upstream as empty on this nginx build. The
  // controller's structured-log contract uses a dash for no upstream request.
  await writeFile(
    `/etc/nginx/conf.d/${id}.conf`,
    `map $upstream_status $${format} { "" "-"; default $upstream_status; }\nlog_format ${format} escape=json '{"status":$status,"upstream":"$${format}","retryAfter":"$sent_http_retry_after"}';\nserver { listen 127.0.0.1:${proxyPort}; access_log ${f.config.manualAccessLog} ${format}; error_page 503 = @maintenance; location @maintenance { default_type application/json; add_header Retry-After 60 always; return 503 '{"error":"maintenance"}'; } location / { if (-f ${f.config.maintenance}) { return 503; } proxy_pass http://127.0.0.1:${appPort}; proxy_set_header Host $http_host; } }`,
  );
  run("systemctl", "daemon-reload");
  run("nginx", "-t");
  run("systemctl", "reload", "nginx");
  run("systemctl", "start", f.config.unit);
  const startupDeadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < startupDeadline) {
    try {
      const response = await fetch(
        new URL("/api/setup/status", f.config.ingressUrl),
        { signal: AbortSignal.timeout(2000) },
      );
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Nginx reload and real service startup are asynchronous. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, "real fixture application must start within 60 seconds");
  const setup = await fetch(new URL("/api/setup", f.config.ingressUrl), {
    method: "POST",
    headers: {
      Origin: f.config.ingressUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      teamName: "手工发布夹具",
      name: "维护者",
      email: "manual@example.test",
      password: "ManualFixture2026!",
    }),
  });
  assert.equal(setup.status, 201);
  const ssh = await sshFixture(t, f);
  const clientRoot = `${f.root}/client`;
  await mkdir(clientRoot, { mode: 0o700 });
  const agentEnvironment = { ...process.env };
  delete agentEnvironment.SSH_AUTH_SOCK;
  delete agentEnvironment.SSH_AGENT_PID;
  const agentSocket = `${clientRoot}/agent.sock`;
  const agentOutput = execFileSync("ssh-agent", ["-s", "-a", agentSocket], {
    env: agentEnvironment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  });
  const agentPid = /^SSH_AGENT_PID=(\d+);/m.exec(agentOutput);
  assert.ok(agentPid, "the new disposable agent must report its own PID");
  ownedAgentPid = Number(agentPid[1]);
  assert.ok(Number.isSafeInteger(ownedAgentPid) && ownedAgentPid > 1);
  Object.assign(agentEnvironment, {
    SSH_AUTH_SOCK: agentSocket,
    SSH_AGENT_PID: String(ownedAgentPid),
  });
  process.env.SSH_AUTH_SOCK = agentEnvironment.SSH_AUTH_SOCK;
  process.env.SSH_AGENT_PID = agentEnvironment.SSH_AGENT_PID;

  // Encrypt only the key just generated by sshFixture. The helper and passphrase
  // are disposable test credentials; no prompts or mutations reach a user's agent.
  const passphrase = `manual-ssh-fixture-${randomUUID()}`;
  await chmod(`${f.root}/ssh-key`, 0o600);
  run(
    "ssh-keygen",
    "-q",
    "-p",
    "-P",
    "",
    "-N",
    passphrase,
    "-f",
    `${f.root}/ssh-key`,
  );
  const askpass = `${clientRoot}/askpass`;
  await writeFile(askpass, `#!/bin/sh\nprintf '%s\\n' '${passphrase}'\n`, {
    mode: 0o700,
  });
  execFileSync("ssh-add", [`${f.root}/ssh-key`], {
    env: {
      ...agentEnvironment,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: "fixture:0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  });
  const result = await ssh("manual-baseline");
  assert.equal(result.code, 0, result.output + result.error);
  const value = JSON.parse(result.output);
  assert.equal(value.mode, "single");
  assert.equal(value.commit, baseline);
  assert.equal(value.runningCommit, baseline);
  assert.equal(value.node, process.version);
  assert.equal(value.platform, "linux");
  assert.equal(value.architecture, "x64");
  assert.equal(value.busy, false);
  assert.equal(value.frozen, false);
  assert.equal(value.maintenance, false);
  assert.ok(!result.output.includes(token));
  assert.ok(!result.output.includes(f.root));

  const invoke = async (command, file) => {
    const response = await ssh(command, file);
    assert.ok(
      !response.output.includes(token),
      "never disclose health credentials",
    );
    assert.ok(!response.output.includes(f.root), "never disclose host paths");
    return { ...response, value: JSON.parse(response.output) };
  };
  const materials = `${f.root}/materials`;
  await mkdir(materials);
  await cp(
    "/fixture-artifact/application.tar.gz",
    `${materials}/application.tar.gz`,
  );
  const receipt = {
    schema: 1,
    mode: "manual",
    commit: "b".repeat(40),
    baseline,
    node: process.version,
    platform: "linux",
    architecture: "x64",
    sha256: await sha256(`${materials}/application.tar.gz`),
    expectedSchema: 8,
    checks: ["architecture", "types", "build", "production-startup"],
    migration: { paths: [], confirmed: false },
    builtAt: new Date().toISOString(),
  };
  await writeFile(`${materials}/receipt.json`, JSON.stringify(receipt));
  const bundle = `${f.root}/bundle.tar.gz`;
  run(
    "tar",
    "-czf",
    bundle,
    "-C",
    materials,
    "application.tar.gz",
    "receipt.json",
  );
  const digest = await sha256(bundle);
  const absent = await invoke("manual-status upload-one");
  assert.equal(absent.value.phase, "absent");
  const uploaded = await invoke(`manual-upload upload-one ${digest}`, bundle);
  assert.equal(uploaded.code, 0, uploaded.output + uploaded.error);
  assert.equal(uploaded.value.phase, "uploaded");
  const status = await invoke("manual-status upload-one");
  assert.equal(status.value.commit, receipt.commit);
  assert.equal(status.value.baseline, baseline);
  assert.equal(status.value.artifactSha256, receipt.sha256);
  assert.equal(status.value.expectedSchema, 8);
  assert.equal(status.value.bundleSha256, digest);
  const duplicate = await invoke(`manual-upload upload-one ${digest}`, bundle);
  assert.deepEqual(duplicate.value, status.value);
  const conflict = await invoke(
    `manual-upload upload-one ${"a".repeat(64)}`,
    bundle,
  );
  assert.equal(conflict.value.error, "UPLOAD_ID_CONFLICT");

  for (const command of [
    "cat /etc/passwd",
    "sh",
    "",
    "manual-baseline;id",
    "manual-baseline extra",
    "manual-status upload-one extra",
    "manual-upload ../escape " + digest,
    "manual-recover upload-one",
  ]) {
    const denied = await ssh(command);
    assert.notEqual(denied.code, 0, command);
    assert.ok(!denied.output.includes("root:"));
  }
  const knownHosts = await readFile(`${f.root}/known_hosts`, "utf8");
  await writeFile(
    `${f.root}/known_hosts`,
    knownHosts.replace(
      /ssh-ed25519 \S+/,
      (await readFile(`${f.root}/ssh-key.pub`, "utf8"))
        .trim()
        .split(" ")
        .slice(0, 2)
        .join(" "),
    ),
  );
  const mismatch = await ssh("manual-baseline");
  assert.notEqual(mismatch.code, 0);
  assert.match(
    mismatch.error,
    /HOST IDENTIFICATION HAS CHANGED|Host key verification failed/,
  );
  await writeFile(`${f.root}/known_hosts`, knownHosts);

  f.config.slots = {};
  await writeFile(`${f.root}/deploy.json`, JSON.stringify(f.config));
  assert.equal((await invoke("manual-baseline")).value.mode, "slots");
  assert.equal(
    (await invoke(`manual-upload slot-attempt ${digest}`, bundle)).value.error,
    "MANUAL_SINGLE_INSTANCE_REQUIRED",
  );
  assert.equal(
    (await invoke(`manual-release upload-one ${baseline}`)).value.error,
    "MANUAL_SINGLE_INSTANCE_REQUIRED",
  );
  delete f.config.slots;
  await writeFile(`${f.root}/deploy.json`, JSON.stringify(f.config));

  const runtimePath = `${f.config.stateDir}/runtime.json`;
  const runtime = await readFile(runtimePath, "utf8");
  await writeFile(
    runtimePath,
    JSON.stringify({ commit: "c".repeat(40), artifact: f.config.artifact }),
  );
  assert.equal(
    (await invoke("manual-baseline")).value.error,
    "BASELINE_DISCREPANCY",
  );
  const originalManifest = await readFile(
    `${f.config.current}/release.json`,
    "utf8",
  );
  await writeFile(
    `${f.config.current}/release.json`,
    JSON.stringify({ ...JSON.parse(originalManifest), commit: "c".repeat(40) }),
  );
  // Matching durable pointers cannot overrule the version of the live process.
  assert.equal(
    (await invoke("manual-baseline")).value.error,
    "BASELINE_DISCREPANCY",
  );
  await writeFile(`${f.config.current}/release.json`, originalManifest);
  await writeFile(runtimePath, runtime);
  await writeFile(
    `${f.config.stateDir}/incident.json`,
    JSON.stringify({ reason: `SECRET ${token} ${f.root}` }),
  );
  const frozen = await invoke("manual-baseline");
  assert.equal(frozen.value.frozen, true);
  assert.equal(frozen.value.reason, "INCIDENT_REQUIRES_MANUAL_RESOLUTION");
  assert.equal(
    (await invoke(`manual-upload new-frozen ${digest}`, bundle)).value.error,
    "INCIDENT_REQUIRES_MANUAL_RESOLUTION",
  );
  assert.equal(
    (await invoke(`manual-release upload-one ${baseline}`)).value.error,
    "INCIDENT_REQUIRES_MANUAL_RESOLUTION",
  );
  assert.equal(
    (await invoke(`manual-upload upload-one ${digest}`, bundle)).value.phase,
    "uploaded",
  );
  await rm(`${f.config.stateDir}/incident.json`);

  const operationPath = `${f.config.stateDir}/operations/upload-one.json`;
  const record = {
    id: "upload-one",
    command: "manual-release",
    phase: "completed",
    commit: receipt.commit,
    baseline,
    actualCommit: receipt.commit,
    artifactSha256: receipt.sha256,
    expectedSchema: 8,
    criteria: {
      processActive: true,
      ready: true,
      version: receipt.commit,
      schema: 8,
      integrity: "ok",
      attachmentsAccessible: true,
      readOnlyPage: true,
      secret: token,
    },
    recovery: "not-needed",
    maintenanceMilliseconds: 1250,
    snapshotId: "snapshot-one",
    createdAt: "2026-09-22T10:00:00.000Z",
    finishedAt: "2026-09-22T10:00:01.250Z",
    failure: `secret ${token} ${f.root}`,
    stderr: token,
    candidate: f.root,
  };
  await writeFile(operationPath, JSON.stringify(record));
  const completed = await invoke("manual-status upload-one");
  assert.equal(completed.value.phase, "completed");
  assert.equal(completed.value.actualCommit, receipt.commit);
  assert.equal(completed.value.runningCommit, baseline);
  assert.equal(completed.value.criteria.integrity, "ok");
  assert.equal(completed.value.maintenanceMilliseconds, 1250);
  assert.equal(completed.value.snapshotId, "snapshot-one");
  assert.equal(completed.value.finishedAt, record.finishedAt);
  // A completed/failed ID must not validate candidate files or dispatch again.
  await rm(`${f.config.incoming}/upload-one/candidate`, { recursive: true });
  assert.deepEqual(
    (await invoke(`manual-release upload-one ${baseline}`)).value,
    completed.value,
  );
  assert.equal(
    (await invoke(`manual-release upload-one ${"c".repeat(40)}`)).value.error,
    "OPERATION_ID_CONFLICT",
  );
  await writeFile(
    operationPath,
    JSON.stringify({
      ...record,
      phase: "failed",
      recovery: "manual-intervention",
    }),
  );
  const failed = await invoke(`manual-release upload-one ${baseline}`);
  assert.equal(failed.value.phase, "failed");
  assert.equal(failed.value.failure, "REMOTE_OPERATION_REJECTED");
  assert.equal(failed.value.recovery, "manual-intervention");
  await writeFile(
    operationPath,
    JSON.stringify({ ...record, phase: "preparing" }),
  );
  await writeFile(
    `${f.config.stateDir}/operation.lock`,
    JSON.stringify({
      id: "upload-one",
      pid: 2147483647,
      bootId: "lost",
      startTime: "0",
    }),
  );
  assert.equal(
    (await invoke("manual-status upload-one")).value.phase,
    "unknown",
  );
  assert.equal(
    (await invoke(`manual-release upload-one ${baseline}`)).value.phase,
    "unknown",
  );
  assert.equal(
    (await invoke(`manual-upload while-lost ${digest}`, bundle)).value.error,
    "PENDING_OPERATION_RECONCILIATION",
  );
  assert.equal(
    (await invoke("manual-baseline")).value.error,
    "PENDING_OPERATION_RECONCILIATION",
  );
  await rm(`${f.config.stateDir}/operation.lock`);
  assert.equal(
    (await invoke(`manual-upload while-pending ${digest}`, bundle)).value.error,
    "PENDING_OPERATION_RECONCILIATION",
  );
  await rm(operationPath);
  await mkdir(`${f.config.stateDir}/requests`, { recursive: true });
  await writeFile(
    `${f.config.stateDir}/requests/lost-request.json`,
    JSON.stringify({
      id: "lost-request",
      args: [
        "--config",
        `${f.root}/deploy.json`,
        "manual-release",
        "--id",
        "lost-request",
        "--baseline",
        baseline,
      ],
    }),
  );
  assert.equal(
    (await invoke("manual-status lost-request")).value.phase,
    "unknown",
  );
  assert.equal(
    (await invoke(`manual-upload while-queued ${digest}`, bundle)).value.error,
    "PENDING_OPERATION_RECONCILIATION",
  );
  await rm(`${f.config.stateDir}/requests/lost-request.json`);

  await writeFile(
    `${f.config.stateDir}/operation.lock`,
    JSON.stringify({ id: "live-worker", ...(await processIdentity()) }),
  );
  assert.equal(
    (await invoke(`manual-upload while-busy ${digest}`, bundle)).value.error,
    "OPERATION_BUSY",
  );
  await rm(`${f.config.stateDir}/operation.lock`);
  await writeFile(f.config.maintenance, "maintenance");
  assert.equal((await invoke("manual-baseline")).value.maintenance, true);
  assert.equal(
    (await invoke(`manual-upload while-maintenance ${digest}`, bundle)).value
      .error,
    "MAINTENANCE_ACTIVE",
  );
  await rm(f.config.maintenance);
  assert.equal(
    (await invoke(`manual-upload bad-digest ${"0".repeat(64)}`, bundle)).value
      .error,
    "UPLOAD_DIGEST_MISMATCH",
  );
  const badBundle = `${f.root}/bad-bundle.tar.gz`;
  await writeFile(`${materials}/plan.json`, "{}");
  run(
    "tar",
    "-czf",
    badBundle,
    "-C",
    materials,
    "application.tar.gz",
    "receipt.json",
    "plan.json",
  );
  assert.equal(
    (
      await invoke(
        `manual-upload extra-file ${await sha256(badBundle)}`,
        badBundle,
      )
    ).value.error,
    "INVALID_MANUAL_BUNDLE",
  );
  run(
    "tar",
    "-czf",
    badBundle,
    "--transform=s|receipt.json|../receipt.json|",
    "-C",
    materials,
    "application.tar.gz",
    "receipt.json",
  );
  assert.equal(
    (
      await invoke(
        `manual-upload traversal ${await sha256(badBundle)}`,
        badBundle,
      )
    ).value.error,
    "UNSAFE_ARCHIVE_PATH",
  );
  await rm(`${materials}/receipt.json`);
  await symlink(f.config.healthTokenFile, `${materials}/receipt.json`);
  run(
    "tar",
    "-czf",
    badBundle,
    "-C",
    materials,
    "application.tar.gz",
    "receipt.json",
  );
  assert.equal(
    (
      await invoke(
        `manual-upload linked-file ${await sha256(badBundle)}`,
        badBundle,
      )
    ).value.error,
    "UNSAFE_ARCHIVE_LINK",
  );
  await rm(`${materials}/receipt.json`);
  await writeFile(
    `${materials}/receipt.json`,
    JSON.stringify({ ...receipt, mode: "legacy" }),
  );
  run(
    "tar",
    "-czf",
    badBundle,
    "-C",
    materials,
    "application.tar.gz",
    "receipt.json",
  );
  assert.equal(
    (
      await invoke(
        `manual-upload bad-receipt ${await sha256(badBundle)}`,
        badBundle,
      )
    ).value.error,
    "INVALID_MANUAL_RECEIPT",
  );
  await chmod(f.config.incoming, 0o777);
  assert.equal(
    (await invoke(`manual-upload unsafe-root ${digest}`, bundle)).value.error,
    "UNSAFE_INCOMING",
  );
  await chmod(f.config.incoming, 0o700);
  const oversized = `${f.root}/oversized`;
  await writeFile(oversized, "");
  await truncate(oversized, 536870913);
  assert.equal(
    (await invoke(`manual-upload oversized ${"0".repeat(64)}`, oversized)).value
      .error,
    "UPLOAD_TOO_LARGE",
  );
  await rm(oversized);
  assert.equal(
    (await invoke("manual-status bad-receipt")).value.phase,
    "absent",
  );

  const pinnedPort = /^\[127\.0\.0\.1\]:(\d+)\s/m.exec(knownHosts);
  assert.ok(pinnedPort, "use the fixture's pinned nonstandard SSH port");
  const clientConfig = {
    host: "127.0.0.1",
    user: "deploy" + f.id.slice(-8),
    port: Number(pinnedPort[1]),
    identityFile: `${f.root}/ssh-key`,
    knownHosts: `${f.root}/known_hosts`,
    runtimeNode: await realpath(process.execPath),
    baselineRecord: `${clientRoot}/baseline.json`,
    outputDir: `${clientRoot}/output`,
    recordsDir: `${clientRoot}/records`,
  };
  const configPath = `${clientRoot}/config.json`;
  await writeFile(configPath, JSON.stringify(clientConfig), { mode: 0o600 });
  const target = {
    host: clientConfig.host,
    user: clientConfig.user,
    port: clientConfig.port,
    hostKeysSha256: await sha256(clientConfig.knownHosts),
  };
  const clientOptions = {
    configPath,
    // The container mounts app at /repository, whose parent would otherwise make
    // the entire filesystem the workspace. All client state is outside this mount.
    workspace: "/repository",
    // Capture/resume must work without any source checkout, fetch or build.
    repository: `${clientRoot}/no-source-checkout`,
    onStep: (message) => t.diagnostic(message),
  };
  // No gateway adapter: load the encrypted envelope, inspect the isolated agent,
  // verify the host pin and execute native SSH, including read-only capture.
  const captured = await runManualRelease({ ...clientOptions, capture: true });
  assert.deepEqual(captured, (await invoke("manual-baseline")).value);
  assert.equal(captured.commit, baseline);
  const capturedRecord = await json(clientConfig.baselineRecord);
  assert.equal(capturedRecord.schema, 1);
  assert.equal(capturedRecord.source, "manual-baseline");
  assert.deepEqual(capturedRecord.target, target);
  assert.deepEqual(capturedRecord.observation, captured);
  assert.ok(Number.isFinite(Date.parse(capturedRecord.observedAt)));

  // Build no sources: repackage the staged fixture runtime with a distinct
  // version label and the client's real external, immutable resume layout.
  const releaseId = `${f.id}-release`;
  const releaseOutput = `${clientConfig.outputDir}/${releaseId}`;
  await mkdir(releaseOutput, { recursive: true, mode: 0o700 });
  await mkdir(clientConfig.recordsDir, { mode: 0o700 });
  const candidateRuntime = `${f.root}/candidate-runtime`;
  await cp("/fixture-runtime", candidateRuntime, { recursive: true });
  const deep = await fetch(new URL("/internal/health", f.config.probeUrl), {
    headers: { "X-Daily-Health": token },
  });
  const expectedSchema = (await deep.json()).schema;
  const manifest = { ...receipt, expectedSchema };
  delete manifest.sha256;
  await writeFile(`${candidateRuntime}/release.json`, JSON.stringify(manifest));
  run(
    "tar",
    "-czf",
    `${releaseOutput}/application.tar.gz`,
    "-C",
    candidateRuntime,
    "build",
    "dist",
    "node_modules",
    "package.json",
    "package-lock.json",
    "release.json",
  );
  const releaseReceipt = {
    ...manifest,
    sha256: await sha256(`${releaseOutput}/application.tar.gz`),
  };
  await writeFile(
    `${releaseOutput}/receipt.json`,
    JSON.stringify(releaseReceipt),
  );
  const releaseBundle = `${releaseOutput}/bundle.tar.gz`;
  run(
    "tar",
    "-czf",
    releaseBundle,
    "-C",
    releaseOutput,
    "application.tar.gz",
    "receipt.json",
  );
  const bundleSha256 = await sha256(releaseBundle);
  const localRecord = {
    schema: 1,
    id: releaseId,
    target,
    receipt: releaseReceipt,
    bundleSha256,
    createdAt: releaseReceipt.builtAt,
    server: null,
  };
  const localRecordPath = `${clientConfig.recordsDir}/${releaseId}.json`;
  await writeFile(localRecordPath, JSON.stringify(localRecord), {
    mode: 0o600,
  });
  const immutableMaterials = () =>
    Promise.all(
      ["application.tar.gz", "receipt.json", "bundle.tar.gz"].map(
        async (name) => {
          const file = `${releaseOutput}/${name}`;
          return {
            name,
            sha256: await sha256(file),
            mtimeNs: (await stat(file, { bigint: true })).mtimeNs,
          };
        },
      ),
    );
  const originalMaterials = await immutableMaterials();

  // Keep the wrong-baseline rejection on another ID, so the actual client's
  // resume starts absent and must itself upload, submit and poll the real job.
  const wrongBaselineId = `${f.id}-wrong-baseline`;
  assert.equal(
    (
      await invoke(
        `manual-upload ${wrongBaselineId} ${bundleSha256}`,
        releaseBundle,
      )
    ).value.phase,
    "uploaded",
  );
  assert.equal(
    (await invoke(`manual-release ${wrongBaselineId} ${"c".repeat(40)}`)).value
      .error,
    "BASELINE_CHANGED",
  );
  assert.equal(
    (await invoke(`manual-status ${releaseId}`)).value.phase,
    "absent",
  );
  const outcome = await runManualRelease({
    ...clientOptions,
    resume: releaseId,
  });
  const actualStatus = await invoke(`manual-status ${releaseId}`);
  assert.equal(actualStatus.code, 0, actualStatus.output + actualStatus.error);
  assert.deepEqual(outcome, actualStatus.value);
  assert.deepEqual(await json(localRecordPath), {
    ...localRecord,
    server: actualStatus.value,
  });
  assert.equal(outcome.phase, "completed", JSON.stringify(outcome));
  assert.equal(outcome.actualCommit, receipt.commit);
  assert.equal(outcome.runningCommit, receipt.commit);
  assert.equal(outcome.commit, receipt.commit);
  assert.equal(outcome.baseline, baseline);
  assert.equal(outcome.bundleSha256, bundleSha256);
  assert.equal(outcome.artifactSha256, releaseReceipt.sha256);
  assert.equal(outcome.expectedSchema, expectedSchema);
  assert.equal(outcome.criteria.schema, expectedSchema);
  assert.equal(outcome.criteria.ready, true);
  assert.equal(outcome.criteria.errorResponses.errors, 0);
  assert.equal(outcome.snapshotId, releaseId);
  assert.ok(outcome.maintenanceMilliseconds < 180000);
  assert.deepEqual(
    (await invoke(`manual-release ${releaseId} ${baseline}`)).value,
    outcome,
  );
  assert.deepEqual(
    await runManualRelease({ ...clientOptions, resume: releaseId }),
    outcome,
  );
  assert.deepEqual((await json(localRecordPath)).server, actualStatus.value);
  assert.deepEqual(
    await immutableMaterials(),
    originalMaterials,
    "resume never rebuilds or rewrites saved materials",
  );
  await assert.rejects(stat(clientOptions.repository), { code: "ENOENT" });

  const { reason: baselineReason, ...nextBaseline } = (
    await invoke("manual-baseline")
  ).value;
  assert.equal(baselineReason, null);
  assert.equal(nextBaseline.commit, receipt.commit);
  const nextBaselineRecord = await json(clientConfig.baselineRecord);
  assert.equal(nextBaselineRecord.schema, 1);
  assert.equal(nextBaselineRecord.source, "manual-release");
  assert.equal(nextBaselineRecord.releaseId, releaseId);
  assert.deepEqual(nextBaselineRecord.target, target);
  assert.equal(nextBaselineRecord.observedAt, outcome.finishedAt);
  assert.deepEqual(nextBaselineRecord.observation, nextBaseline);
  succeeded = true;
});
