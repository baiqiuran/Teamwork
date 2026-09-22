import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  realpath,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { setTimeout as wait } from "node:timers/promises";
import {
  preflightRelease,
  migrationPaths,
  migrationSummary,
  confirmMigration,
} from "./release-guards.mjs";
import {
  buildManualArtifact,
  fileSha256,
  manualChecks,
} from "./manual-artifact.mjs";
import { localNodeVersion } from "./manual-preflight.mjs";

const exec = promisify(execFile);
const repositoryDefault = fileURLToPath(new URL("../", import.meta.url));
const workspaceDefault = resolve(repositoryDefault, "..");
const SHA = /^[a-f0-9]{40}$/,
  DIGEST = /^[a-f0-9]{64}$/,
  ID = /^[a-zA-Z0-9_-]{1,80}$/;
const HELP = `Local manual release (no business tests or migration-note gate)
  node scripts/manual-release.mjs --config /external/config.json --capture-baseline
  node scripts/manual-release.mjs --config /external/config.json
  node scripts/manual-release.mjs --config /external/config.json --resume ID

Config JSON: host, user, port, identityFile, knownHosts, runtimeNode,
  baselineRecord, outputDir, recordsDir. All file/directory fields are absolute.
Config, encrypted ed25519 OpenSSH identityFile, pinned knownHosts, baselineRecord,
outputDir and recordsDir must be outside the WHOLE workspace, not just app/.
Load the existing encrypted key into your SSH agent yourself. No key creation,
permission changes, password prompts, arbitrary remote commands or scp are used.
runtimeNode is a LOCAL executable with exactly the captured production version:
on Windows use the matching Windows Node distribution, not a Linux binary.

--capture-baseline is explicitly read-only on the server: manual-baseline only.
It writes baselineRecord locally from live runtime/readiness observations. Release
mode never captures a baseline implicitly: build and fresh-DB startup precede SSH.
A release that the server proves completed (actual version, criteria, snapshot id
and maintenance duration all matching this bundle) replaces baselineRecord, so the
next release diffs against it. Resuming an older completion never rewrites a newer
observation.
SQLite changes across the full baseline..HEAD history require typing the exact
MIGRATE <baseline> <commit> phrase in a terminal. No changes means no prompt.

An ID and immutable bundle digest are saved before upload. Keep both external
outputDir/ID and recordsDir/ID.json to resume (including on another machine).
--resume queries status, never rebuilds, and never retries failed/unknown jobs.
Pending jobs are observed for up to 4 minutes, with 2-second waits. Disconnections
require explicit --resume; a failed local record write is never called success.
`;

function fail(message) {
  const error = new Error(message);
  error.safeForDisplay = true;
  throw error;
}
function inside(path, root) {
  const value = relative(root, path);
  return (
    !value ||
    (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
  );
}
async function canonical(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonical(parent), relative(parent, path));
  }
}
async function externalPath(path, workspace, label) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\r\n\0]/.test(path))
    fail(`${label}_ABSOLUTE_PATH_REQUIRED`);
  if (
    inside(resolve(path), workspace) ||
    inside(await canonical(path), await canonical(workspace))
  )
    fail(`${label}_OUTSIDE_WORKSPACE_REQUIRED`);
  return resolve(path);
}
async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Read only the public envelope: never decrypt or invoke a passphrase prompt.
function encryptedEd25519(text) {
  try {
    if (
      !/^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END OPENSSH PRIVATE KEY-----\s*$/.test(
        text,
      )
    )
      throw new Error();
    const data = Buffer.from(
      text.replace(/-----[^\n]+-----/g, "").replace(/\s/g, ""),
      "base64",
    );
    const magic = Buffer.from("openssh-key-v1\0");
    if (!data.subarray(0, magic.length).equals(magic)) throw new Error();
    let offset = magic.length;
    const uint = () => {
      const n = data.readUInt32BE(offset);
      offset += 4;
      return n;
    };
    const string = () => {
      const n = uint();
      if (n > data.length - offset) throw new Error();
      const value = data.subarray(offset, offset + n);
      offset += n;
      return value;
    };
    if (
      string().toString() === "none" ||
      string().toString() !== "bcrypt" ||
      !string().length ||
      uint() !== 1
    )
      throw new Error();
    const publicKey = string();
    if (
      publicKey.readUInt32BE(0) !== 11 ||
      publicKey.subarray(4, 15).toString() !== "ssh-ed25519" ||
      publicKey.readUInt32BE(15) !== 32 ||
      publicKey.length !== 51
    )
      throw new Error();
    if (string().length < 32 || offset !== data.length) throw new Error();
    return `ssh-ed25519 ${publicKey.toString("base64")}`;
  } catch {
    fail(
      "ENCRYPTED_ED25519_KEY_REQUIRED: use an existing passphrase-protected OpenSSH key via an agent",
    );
  }
}

export async function loadManualConfig(
  file,
  { workspace = workspaceDefault } = {},
) {
  try {
    file = await externalPath(resolve(file), workspace, "CONFIG");
    const value = await json(file);
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value.host ?? "") ||
      !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(value.user ?? "") ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535
    )
      fail("CONFIG_TARGET_INVALID");
    for (const name of [
      "identityFile",
      "knownHosts",
      "baselineRecord",
      "outputDir",
      "recordsDir",
    ])
      value[name] = await externalPath(
        value[name],
        workspace,
        name.toUpperCase(),
      );
    if (
      !isAbsolute(value.runtimeNode ?? "") ||
      !(await lstat(value.runtimeNode)).isFile()
    )
      fail("LOCAL_NODE_INVALID");
    if (
      !(await lstat(value.identityFile)).isFile() ||
      !(await lstat(value.knownHosts)).isFile()
    )
      fail("SSH_FILE_INVALID");
    value.publicIdentity = encryptedEd25519(
      await readFile(value.identityFile, "utf8"),
    );
    const lookup =
      value.port === 22 ? value.host : `[${value.host}]:${value.port}`;
    const { stdout } = await exec(
      "ssh-keygen",
      ["-F", lookup, "-f", value.knownHosts],
      { windowsHide: true, timeout: 10000 },
    );
    // Exact host entries (or hashed entries) only; no wildcard/CA trust expansion.
    const pins = stdout
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"));
    if (
      !pins.length ||
      pins.some((line) => {
        const host = line.split(/\s+/)[0];
        return !host.startsWith("|1|") && !host.split(",").includes(lookup);
      })
    )
      fail("PINNED_HOST_REQUIRED");
    value.target = {
      host: value.host,
      user: value.user,
      port: value.port,
      hostKeysSha256: await fileSha256(value.knownHosts),
    };
    return value;
  } catch (error) {
    if (error.safeForDisplay) throw error;
    fail(
      "CONFIG_INVALID: verify external paths, encrypted identity, pinned host and local Node; sensitive paths are not logged",
    );
  }
}

export function sshArguments(config, verb, id, value) {
  const valid =
    verb === "manual-baseline"
      ? !id && !value
      : verb === "manual-status"
        ? ID.test(id ?? "") && !value
        : verb === "manual-upload"
          ? ID.test(id ?? "") && DIGEST.test(value ?? "")
          : verb === "manual-release"
            ? ID.test(id ?? "") && SHA.test(value ?? "")
            : false;
  if (!valid) fail("REMOTE_VERB_INVALID");
  const pins = config.knownHosts.replace(/\\/g, "/");
  const options = [
    "BatchMode=yes",
    "IdentitiesOnly=yes",
    "StrictHostKeyChecking=yes",
    `UserKnownHostsFile=${/\s/.test(pins) ? JSON.stringify(pins) : pins}`,
    "GlobalKnownHostsFile=none",
    "UpdateHostKeys=no",
    "VerifyHostKeyDNS=no",
    "ForwardAgent=no",
    "ClearAllForwardings=yes",
    "PermitLocalCommand=no",
    "ControlMaster=no",
    "ControlPath=none",
    "ProxyCommand=none",
    "ProxyJump=none",
    "PasswordAuthentication=no",
    "KbdInteractiveAuthentication=no",
    "PreferredAuthentications=publickey",
    "ConnectionAttempts=1",
    "ConnectTimeout=15",
    "ServerAliveInterval=10",
    "ServerAliveCountMax=2",
  ];
  return [
    "-F",
    "none",
    "-T",
    ...options.flatMap((option) => ["-o", option]),
    "-i",
    config.identityFile,
    "-p",
    String(config.port),
    `${config.user}@${config.host}`,
    [verb, id, value].filter(Boolean).join(" "),
  ];
}

function connectionEnvironment() {
  const allowed = new Set([
    "path",
    "systemroot",
    "windir",
    "comspec",
    "pathext",
    "temp",
    "tmp",
    "home",
    "userprofile",
    "ssh_auth_sock",
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      allowed.has(key.toLowerCase()),
    ),
  );
}
function sshGateway(config) {
  let agentChecked = false;
  return async (verb, id, value, { bundle } = {}) => {
    if (!agentChecked) {
      try {
        const { stdout } = await exec("ssh-add", ["-L"], {
          env: connectionEnvironment(),
          windowsHide: true,
          timeout: 10000,
        });
        if (
          !stdout
            .split(/\r?\n/)
            .some(
              (line) =>
                line.split(/\s+/).slice(0, 2).join(" ") ===
                config.publicIdentity,
            )
        )
          throw new Error();
      } catch {
        fail(
          "SSH_AGENT_KEY_REQUIRED: load the configured encrypted key into the agent; no key paths are logged",
        );
      }
      agentChecked = true;
    }
    return new Promise((done, reject) => {
      const child = spawn("ssh", sshArguments(config, verb, id, value), {
        env: connectionEnvironment(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
      let output = "",
        input;
      const timer = setTimeout(
        () => child.kill(),
        verb === "manual-upload" ? 600000 : 45000,
      );
      child.stdout.on("data", (data) => {
        output += data;
        if (output.length > 1024 * 1024) child.kill();
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("REMOTE_CONNECTION_LOST"));
      });
      child.stdin.on("error", () => {}); // EPIPE is settled by the SSH exit status.
      child.once("close", () => {
        clearTimeout(timer);
        input?.destroy();
        try {
          if (output.length > 1024 * 1024) throw new Error();
          const result = JSON.parse(output);
          if (!result || typeof result !== "object" || Array.isArray(result))
            throw new Error();
          done(result); // Preserve durable failures, including a nonzero SSH exit.
        } catch {
          reject(
            new Error(
              "REMOTE_CONNECTION_LOST: no complete JSON response; do not resend blindly",
            ),
          );
        }
      });
      if (bundle) {
        input = createReadStream(bundle);
        input.once("error", () => child.kill());
        input.pipe(child.stdin);
      } else child.stdin.end();
    });
  };
}

async function durableJson(file, value, { exclusive = false } = {}) {
  let handle;
  const temporary = exclusive ? file : `${file}.${randomUUID()}.partial`;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!exclusive) await rename(temporary, file);
    // fsync directories where supported; Windows rejects directory handles.
    if (process.platform !== "win32") {
      const directory = await open(dirname(file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch {
    await handle?.close().catch(() => {});
    if (!exclusive) await rm(temporary, { force: true }).catch(() => {});
    fail(
      "LOCAL_RECORD_WRITE_FAILED: server outcome is not safely recorded; success cannot be reported",
    );
  }
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function validateBaseline(value) {
  if (
    !value ||
    !SHA.test(value.commit ?? "") ||
    !/^v\d+\.\d+\.\d+$/.test(value.node ?? "") ||
    value.platform !== "linux" ||
    value.architecture !== "x64" ||
    !["busy", "frozen", "maintenance"].every(
      (key) => typeof value[key] === "boolean",
    ) ||
    (value.mode !== undefined && value.mode !== "single") ||
    (value.runningCommit !== undefined && value.runningCommit !== value.commit)
  )
    fail(
      "BASELINE_INVALID: expected live single-instance Linux x64 runtime/readiness facts",
    );
  return value;
}
function available(value) {
  validateBaseline(value);
  if (value.busy || value.frozen || value.maintenance)
    fail(
      "REMOTE_NOT_AVAILABLE: busy, frozen or in maintenance; no upload/release allowed",
    );
}
function validateReceipt(receipt) {
  const keys = [
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
  ].sort();
  if (
    !receipt ||
    !same(Object.keys(receipt).sort(), keys) ||
    receipt.schema !== 1 ||
    receipt.mode !== "manual" ||
    !SHA.test(receipt.commit) ||
    !SHA.test(receipt.baseline) ||
    !DIGEST.test(receipt.sha256) ||
    !/^v\d+\.\d+\.\d+$/.test(receipt.node) ||
    receipt.platform !== "linux" ||
    receipt.architecture !== "x64" ||
    !Number.isSafeInteger(receipt.expectedSchema) ||
    receipt.expectedSchema < 0 ||
    !same(receipt.checks, manualChecks) ||
    !Number.isFinite(Date.parse(receipt.builtAt)) ||
    !Array.isArray(receipt.migration?.paths) ||
    !receipt.migration.paths.every(
      (path) =>
        typeof path === "string" &&
        path.startsWith("server/infrastructure/sqlite/"),
    ) ||
    receipt.migration.confirmed !== receipt.migration.paths.length > 0
  )
    fail("LOCAL_RECEIPT_INVALID");
}

export async function captureBaseline({
  config,
  gateway = sshGateway(config),
}) {
  const observation = validateBaseline(await gateway("manual-baseline"));
  await mkdir(dirname(config.baselineRecord), { recursive: true });
  await durableJson(config.baselineRecord, {
    schema: 1,
    source: "manual-baseline",
    target: config.target,
    observedAt: new Date().toISOString(),
    observation,
  });
  return observation;
}

/** Public protocol boundary. A gateway sends only whitelisted verbs and returns
 * the sanitized server record. Resume never reads source or invokes a build. */
export async function resumeSavedRelease({
  config,
  id,
  gateway = sshGateway(config),
  onStep = () => {},
  maxWaitMs = 240000,
  pollMs = 2000,
}) {
  if (!ID.test(id ?? "")) fail("RELEASE_ID_INVALID");
  const file = resolve(config.recordsDir, `${id}.json`);
  try {
    const state = await json(file);
    if (
      state.schema !== 1 ||
      state.id !== id ||
      !same(state.target, config.target) ||
      !DIGEST.test(state.bundleSha256 ?? "")
    )
      fail("LOCAL_RECORD_INVALID");
    validateReceipt(state.receipt);
    const output = resolve(config.outputDir, id),
      bundle = resolve(output, "bundle.tar.gz");
    if (
      (await fileSha256(bundle)) !== state.bundleSha256 ||
      (await fileSha256(resolve(output, "application.tar.gz"))) !==
        state.receipt.sha256 ||
      !same(await json(resolve(output, "receipt.json")), state.receipt)
    )
      fail(
        "LOCAL_BUNDLE_MISMATCH: resume requires the original bundle and receipt; never rebuild this ID",
      );
    const save = async (server) => {
      state.server = server;
      await durableJson(file, state); // Even failed/unknown/mismatched outcomes are evidence.
      if (
        !server ||
        server.id !== id ||
        ![
          "absent",
          "uploaded",
          "accepted",
          "running",
          "completed",
          "failed",
          "unknown",
        ].includes(server.phase)
      )
        fail("REMOTE_STATUS_INVALID");
      if (server.phase === "failed")
        fail(
          "REMOTE_RELEASE_FAILED: inspect the saved server record; never retry this ID",
        );
      if (server.phase === "unknown")
        fail(
          "REMOTE_RELEASE_UNKNOWN: operator investigation required; never retry this ID",
        );
      if (
        server.phase !== "absent" &&
        (server.commit !== state.receipt.commit ||
          server.baseline !== state.receipt.baseline ||
          server.bundleSha256 !== state.bundleSha256 ||
          (server.artifactSha256 !== undefined &&
            server.artifactSha256 !== state.receipt.sha256) ||
          (server.expectedSchema !== undefined &&
            server.expectedSchema !== state.receipt.expectedSchema))
      )
        fail(
          "REMOTE_IDENTITY_MISMATCH: server record does not describe the immutable local bundle",
        );
      onStep(`Release ${id}: ${server.phase}`);
      return server;
    };
    const compareLive = async () => {
      const live = await gateway("manual-baseline");
      available(live);
      if (
        live.commit !== state.receipt.baseline ||
        live.node !== state.receipt.node ||
        live.platform !== state.receipt.platform ||
        live.architecture !== state.receipt.architecture
      )
        fail(
          "LIVE_BASELINE_CHANGED: capture explicitly and start a new release; no upload/release performed",
        );
    };
    const observed = await gateway("manual-status", id);
    const previousPhase = state.server?.phase;
    if (
      ["failed", "unknown"].includes(previousPhase) ||
      (["accepted", "running", "completed"].includes(previousPhase) &&
        ["absent", "uploaded"].includes(observed.phase))
    ) {
      state.lastObserved = observed;
      await durableJson(file, state);
      fail(
        previousPhase === "failed"
          ? "REMOTE_RELEASE_FAILED: previously recorded failure cannot be replayed"
          : previousPhase === "unknown"
            ? "REMOTE_RELEASE_UNKNOWN: previously unknown outcome requires investigation"
            : "REMOTE_STATUS_REGRESSION: durable job history disappeared; do not replay",
      );
    }
    let server = await save(observed);
    if (server.phase === "absent") {
      await compareLive();
      server = await save(
        await gateway("manual-upload", id, state.bundleSha256, { bundle }),
      );
      if (server.phase !== "uploaded") fail("REMOTE_UPLOAD_NOT_CONFIRMED");
    }
    if (server.phase === "uploaded") {
      await compareLive();
      server = await save(
        await gateway("manual-release", id, state.receipt.baseline),
      );
    }
    const deadline = Date.now() + maxWaitMs;
    while (["accepted", "running"].includes(server.phase)) {
      if (Date.now() >= deadline)
        fail(
          "REMOTE_RELEASE_PENDING: bounded observation ended; use --resume to continue observing",
        );
      onStep(
        `Waiting ${Math.min(pollMs, deadline - Date.now())}ms for the existing server job (no resubmission)`,
      );
      await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      server = await save(await gateway("manual-status", id));
    }
    if (server.phase !== "completed")
      fail("REMOTE_STATUS_INVALID: release did not complete");
    const criteria = server.criteria;
    if (
      server.actualCommit !== state.receipt.commit ||
      server.artifactSha256 !== state.receipt.sha256 ||
      server.expectedSchema !== state.receipt.expectedSchema ||
      criteria?.processActive !== true ||
      criteria.ready !== true ||
      criteria.version !== state.receipt.commit ||
      criteria.schema !== state.receipt.expectedSchema ||
      criteria.integrity !== "ok" ||
      criteria.attachmentsAccessible !== true ||
      criteria.readOnlyPage !== true ||
      criteria.errorResponses?.errors !== 0 ||
      !ID.test(server.snapshotId ?? "") ||
      !Number.isSafeInteger(server.maintenanceMilliseconds) ||
      server.maintenanceMilliseconds < 0 ||
      server.maintenanceMilliseconds > 180000 ||
      !Number.isFinite(Date.parse(server.finishedAt))
    )
      fail(
        "REMOTE_ACCEPTANCE_INVALID: completion lacks matching acceptance evidence; baseline unchanged",
      );
    const previousBaseline = await json(config.baselineRecord).catch(
      (error) => {
        if (error.code === "ENOENT") return null;
        fail("LOCAL_BASELINE_READ_FAILED: existing baseline was not replaced");
      },
    );
    if (
      previousBaseline &&
      same(previousBaseline.target, config.target) &&
      Date.parse(previousBaseline.observedAt) > Date.parse(server.finishedAt)
    )
      return server;
    await mkdir(dirname(config.baselineRecord), { recursive: true });
    await durableJson(config.baselineRecord, {
      schema: 1,
      source: "manual-release",
      releaseId: id,
      target: config.target,
      observedAt: server.finishedAt,
      observation: {
        mode: "single",
        commit: server.actualCommit,
        runningCommit: server.actualCommit,
        node: state.receipt.node,
        platform: state.receipt.platform,
        architecture: state.receipt.architecture,
        busy: false,
        frozen: false,
        maintenance: false,
      },
    });
    return server;
  } catch (error) {
    error.resumeId = id;
    throw error;
  }
}

export async function runManualRelease({
  configPath,
  capture = false,
  resume,
  repository = repositoryDefault,
  workspace = workspaceDefault,
  gateway,
  onStep = console.log,
}) {
  const config = await loadManualConfig(configPath, { workspace });
  gateway ??= sshGateway(config);
  if (capture) {
    const value = await captureBaseline({ config, gateway });
    onStep(
      `Captured read-only baseline ${value.commit} (${value.node}, ${value.platform}/${value.architecture}); busy=${value.busy}, frozen=${value.frozen}, maintenance=${value.maintenance}`,
    );
    return value;
  }
  if (resume)
    return resumeSavedRelease({ config, id: resume, gateway, onStep });
  let recorded;
  try {
    recorded = await json(config.baselineRecord);
  } catch {
    fail("BASELINE_CAPTURE_REQUIRED: run --capture-baseline explicitly first");
  }
  if (
    recorded.schema !== 1 ||
    !["manual-baseline", "manual-release"].includes(recorded.source) ||
    (recorded.source === "manual-release" &&
      !ID.test(recorded.releaseId ?? "")) ||
    !same(recorded.target, config.target) ||
    !Number.isFinite(Date.parse(recorded.observedAt))
  )
    fail(
      "BASELINE_CAPTURE_REQUIRED: no trusted observation for this pinned target",
    );
  available(recorded.observation);
  onStep("Refresh origin/main before build...");
  try {
    await exec(
      "git",
      [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      ],
      {
        cwd: repository,
        env: connectionEnvironment(),
        windowsHide: true,
        timeout: 120000,
      },
    );
  } catch {
    fail("ORIGIN_REFRESH_FAILED: no build performed");
  }
  const identity = await preflightRelease({
    repository,
    baseline: recorded.observation.commit,
  });
  onStep(`Release ${identity.baseline} -> ${identity.commit}`);
  const paths = await migrationPaths({ repository, ...identity });
  let response;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (paths.length && interactive) {
    onStep(
      `Irreversible SQLite history changes (including deletions, renames and reverts):\n${paths.map((path) => `  ${JSON.stringify(path)}`).join("\n")}`,
    );
    const summary = await migrationSummary({ repository, ...identity });
    onStep(
      `Review SQLite history patches (control characters escaped):\n${summary
        .split(/\r?\n/)
        .map((line) => JSON.stringify(line))
        .join("\n")}`,
    );
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      response = await prompt.question(
        `Type exactly MIGRATE ${identity.baseline} ${identity.commit}\n> `,
      );
    } catch {
      fail(
        "MIGRATION_CONFIRMATION_REQUIRED: cancelled; no build or upload performed",
      );
    } finally {
      prompt.close();
    }
  }
  const migration = confirmMigration({
    ...identity,
    paths,
    interactive,
    response,
  });
  if (
    (await localNodeVersion(config.runtimeNode)) !== recorded.observation.node
  )
    fail("NODE_VERSION_MISMATCH");
  await mkdir(config.outputDir, { recursive: true });
  await mkdir(config.recordsDir, { recursive: true });
  const id = `manual-${randomUUID()}`;
  const artifact = await buildManualArtifact({
    repository,
    ...identity,
    runtimeNode: config.runtimeNode,
    node: recorded.observation.node,
    migration,
    output: resolve(config.outputDir, id),
    onStep,
  });
  const state = {
    schema: 1,
    id,
    target: config.target,
    receipt: artifact.receipt,
    bundleSha256: artifact.bundleSha256,
    createdAt: new Date().toISOString(),
    server: null,
  };
  await durableJson(resolve(config.recordsDir, `${id}.json`), state, {
    exclusive: true,
  });
  onStep(`Saved release ${id}; all server actions use this immutable bundle.`);
  return resumeSavedRelease({ config, id, gateway, onStep });
}

async function main() {
  const args = process.argv.slice(2),
    options = {};
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(HELP);
    return;
  }
  while (args.length) {
    const flag = args.shift();
    if (
      !["--config", "--resume", "--capture-baseline"].includes(flag) ||
      Object.hasOwn(options, flag)
    )
      fail("USAGE_INVALID: use --help");
    if (flag === "--capture-baseline") options[flag] = true;
    else {
      const value = args.shift();
      if (!value || value.startsWith("--")) fail("USAGE_INVALID: use --help");
      options[flag] = value;
    }
  }
  if (
    !options["--config"] ||
    (options["--resume"] &&
      (!ID.test(options["--resume"]) || options["--capture-baseline"]))
  )
    fail("USAGE_INVALID: use --help");
  await runManualRelease({
    configPath: options["--config"],
    resume: options["--resume"],
    capture: options["--capture-baseline"],
  });
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    const knownLocalError =
      /^(DIRTY_WORKTREE:|HEAD_NOT_PUSHED:|PRODUCTION_BASELINE_|MIGRATION_|NODE_VERSION_MISMATCH(?:$|:)|LOCAL_STEP_FAILED:|STARTUP_|UNSAFE_ARCHIVE_|UNSAFE_RUNTIME_LINK:|NATIVE_RUNTIME_DEPENDENCY:|REMOTE_CONNECTION_LOST(?:$|:))/.test(
        error.message,
      );
    console.error(
      error.safeForDisplay || knownLocalError
        ? error.message
        : "LOCAL_OPERATION_FAILED: check external configuration and local records; sensitive details suppressed",
    );
    if (ID.test(error.resumeId ?? ""))
      console.error(
        `Resume/inspect without rebuilding: node scripts/manual-release.mjs --config <external.json> --resume ${error.resumeId}`,
      );
    process.exitCode = 1;
  });
}
