import assert from "node:assert/strict";
import { mkdir, readFile, rename, symlink, cp } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { json, durable, sha256, syncPath } from "./io.mjs";
import { capacity, command, assertStopped, exists, start } from "./host.mjs";
import { archiveSize, extract } from "./snapshots.mjs";

export function slotConfig(config, slot) {
  const settings = config.slots[slot];
  return {
    ...config,
    unit: settings.unit,
    probeUrl: `http://127.0.0.1:${settings.port}/api/setup/status`,
  };
}
function validateSlots(config) {
  assert.deepEqual(Object.keys(config.slots).sort(), ["blue", "green"]);
  assert.ok(
    ["blue", "green"].includes(config.activeSlot),
    "ACTIVE_SLOT_REQUIRED",
  );
  for (const slot of Object.values(config.slots)) {
    assert.match(slot.unit, /^[a-zA-Z0-9@._-]+\.service$/);
    assert.ok(
      Number.isInteger(slot.port) && slot.port > 1024 && slot.port < 65536,
    );
    for (const path of [slot.link, slot.envFile])
      assert.ok(path.startsWith("/") && resolve(path) === path);
  }
  assert.notEqual(config.slots.blue.port, config.slots.green.port);
  assert.notEqual(config.slots.blue.unit, config.slots.green.unit);
  assert.notEqual(config.slots.blue.link, config.slots.green.link);
  assert.ok(
    config.upstreamFile.startsWith("/") &&
      config.healthTokenFile.startsWith("/"),
  );
}
export async function prepare(config, operation) {
  validateSlots(config);
  const current = await json(resolve(config.current, "release.json"));
  assert.equal(current.commit, operation.baseline, "BASELINE_CHANGED");
  const receipt = await json(resolve(operation.candidate, "receipt.json"));
  const proof = await json(resolve(operation.candidate, "upgrade.json"));
  const archive = resolve(operation.candidate, "application.tar.gz");
  assert.match(receipt.commit, /^[a-f0-9]{40}$/);
  assert.equal(receipt.node, process.version);
  assert.equal(receipt.platform, process.platform);
  assert.equal(receipt.architecture, process.arch);
  assert.deepEqual(receipt.checks, [
    "architecture",
    "types",
    "build",
    "api",
    "browser",
    "production-runtime",
  ]);
  assert.equal(await sha256(archive), receipt.sha256, "ARTIFACT_CHECKSUM");
  assert.equal(proof.from, current.commit, "BASELINE_CHANGED");
  assert.equal(proof.to, receipt.commit);
  assert.equal(proof.artifactSha256, receipt.sha256);
  assert.equal(proof.upgradeVerified, true, "UPGRADE_PROOF_REQUIRED");
  assert.equal(
    proof.planSha256,
    await sha256(resolve(operation.candidate, "plan.json")),
    "MIGRATION_PLAN_MISMATCH",
  );
  const plan = await json(resolve(operation.candidate, "plan.json"));
  assert.equal(plan.automatic, true);
  assert.equal(plan.from, current.commit);
  assert.equal(plan.to, receipt.commit);
  const slot = config.activeSlot === "blue" ? "green" : "blue";
  assertStopped(config.slots[slot].unit);
  await capacity(config, archiveSize(archive) * 2);
  const release = resolve(config.releases, `${receipt.commit}-${operation.id}`);
  await mkdir(release, { mode: 0o755 });
  extract(archive, release);
  command("/bin/chmod", "-R", "a-s,a+rX", release);
  const manifest = await json(resolve(release, "release.json"));
  assert.equal(manifest.commit, receipt.commit);
  assert.equal(manifest.node, process.version);
  // Keep a matching archive even if the incoming upload is subsequently removed.
  const artifact = resolve(release, "application.tar.gz");
  await cp(archive, artifact);
  await syncPath(artifact);
  command(
    process.execPath,
    fileURLToPath(new URL("./preflight.mjs", import.meta.url)),
    release,
    receipt.commit,
  );
  return {
    slot,
    release,
    artifact,
    commit: receipt.commit,
    oldSlot: config.activeSlot,
    oldCommit: current.commit,
    oldArtifact: config.artifact,
  };
}
async function point(link, directory, id) {
  await mkdir(dirname(link), { recursive: true });
  const next = `${link}.${id}`;
  await symlink(directory, next);
  await rename(next, link);
  await syncPath(dirname(link));
}
export async function probe(
  config,
  commit,
  port,
  deadline = Date.now() + 120000,
) {
  const origin = `http://127.0.0.1:${port}`;
  const token = (await readFile(config.healthTokenFile, "utf8")).trim();
  assert.ok(token.length >= 32, "HEALTH_TOKEN_TOO_SHORT");
  const headers = {
    Host: new URL(config.ingressUrl).host,
    "X-Forwarded-Proto": new URL(config.ingressUrl).protocol.slice(0, -1),
  };
  const read = (path, extra = {}) => {
    assert.ok(Date.now() < deadline, "STARTUP_TIMEOUT");
    return fetch(origin + path, {
      ...extra,
      headers: { ...headers, ...extra.headers },
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(5000, deadline - Date.now())),
      ),
    });
  };
  const publicReady = await read("/health/ready");
  assert.equal(publicReady.status, 200, "READINESS_FAILED");
  assert.deepEqual(
    await publicReady.json(),
    { ready: true, version: commit },
    "WRONG_RUNNING_VERSION",
  );
  const health = await read("/internal/health", {
    headers: { "X-Daily-Health": token },
  });
  assert.equal(health.status, 200, "LOCAL_HEALTH_FAILED");
  const detail = await health.json();
  assert.equal(detail.integrity, "ok");
  assert.equal(detail.version, commit);
  assert.equal(detail.initialized, true, "EXISTING_TEAM_MISSING");
  assert.equal(
    detail.attachmentsAccessible,
    true,
    "ATTACHMENT_STORAGE_UNAVAILABLE",
  );
  assert.equal((await read("/login")).status, 200);
  assert.equal(
    (await read("/.well-known/oauth-authorization-server")).status,
    200,
  );
  assert.equal((await read("/oauth/authorize")).status, 400);
  assert.equal((await read("/mcp", { method: "POST" })).status, 401);
  return detail;
}
export async function externalProbe(config, commit) {
  const read = (path, options = {}) =>
    fetch(new URL(path, config.ingressUrl), {
      ...options,
      signal: AbortSignal.timeout(5000),
    });
  const ready = await read("/health/ready");
  assert.equal(ready.status, 200, "PUBLIC_READINESS_FAILED");
  const actual = await ready.json();
  assert.deepEqual(
    actual,
    { ready: true, version: commit },
    "PUBLIC_VERSION_MISMATCH",
  );
  for (const [path, status] of [
    ["/login", 200],
    ["/.well-known/oauth-authorization-server", 200],
    ["/oauth/authorize", 400],
  ])
    assert.equal((await read(path)).status, status, "PUBLIC_PROTOCOL_FAILED");
  assert.equal(
    (await read("/mcp", { method: "POST" })).status,
    401,
    "PUBLIC_MCP_AUTH_FAILED",
  );
  return actual;
}
export async function reloadProxy(deadline = Date.now() + 120000) {
  command("/usr/sbin/nginx", "-t");
  const master = command(
    "/bin/systemctl",
    "show",
    "nginx",
    "--property=MainPID",
    "--value",
  ).trim();
  assert.match(master, /^[1-9][0-9]*$/);
  const workers = (
    await readFile(`/proc/${master}/task/${master}/children`, "utf8")
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  command("/bin/systemctl", "reload", "nginx");
  // A successful reload signal does not mean old workers/keep-alive routes
  // have disappeared. Do not open while they can still use the old upstream.
  while (
    (await Promise.all(workers.map((pid) => exists(`/proc/${pid}`)))).some(
      Boolean,
    )
  ) {
    assert.ok(Date.now() < deadline, "PROXY_DRAIN_TIMEOUT");
    await new Promise((done) => setTimeout(done, 50));
  }
}
export async function activate(config, operation) {
  const target = operation.target;
  for (const slot of Object.values(config.slots)) assertStopped(slot.unit);
  const selected = config.slots[target.slot];
  const token = (await readFile(config.healthTokenFile, "utf8")).trim();
  assert.match(token, /^[a-zA-Z0-9_-]{32,128}$/);
  await durable(
    selected.envFile,
    `PORT=${selected.port}\nDAILY_HEALTH_TOKEN=${token}\n`,
  );
  await point(selected.link, target.release, operation.id);
  await point(config.current, target.release, operation.id);
  const deadline = Date.now() + 120000;
  await start(slotConfig(config, target.slot), deadline);
  await probe(config, target.commit, selected.port, deadline);
  await durable(
    config.upstreamFile,
    `server 127.0.0.1:${selected.port};\n`,
    0o644,
  );
  await reloadProxy(deadline);
  // The proxy remains in maintenance. New requests cannot reach the new data yet.
  assert.ok(await exists(config.maintenance), "MAINTENANCE_REQUIRED");
  await durable(resolve(config.stateDir, "runtime.json"), {
    commit: target.commit,
    slot: target.slot,
    artifact: target.artifact,
  });
  return slotConfig(config, target.slot);
}
