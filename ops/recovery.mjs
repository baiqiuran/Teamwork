import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFile, readlink, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { durable, json } from "./io.mjs";
import {
  configuration,
  command,
  maintenance,
  stop,
  start,
  exists,
  assertStopped,
} from "./host.mjs";
import { slotConfig, probe, externalProbe, reloadProxy } from "./release.mjs";

export async function freeze(config, operation, reason, closeTraffic) {
  const path = resolve(config.stateDir, "incident.json");
  const prior = (await exists(path)) ? await json(path) : {};
  await durable(path, {
    id: prior.id ?? operation.id,
    at: prior.at ?? new Date().toISOString(),
    reason,
    mayHaveOpenedAt:
      operation.mayHaveOpenedAt ??
      operation.recoveryOpeningAt ??
      prior.mayHaveOpenedAt,
  });
  if (closeTraffic) {
    try {
      await maintenance(config, true);
    } catch (error) {
      // A broken proxy cannot acknowledge the gate; stop application writers
      // as a second containment boundary and preserve the diagnosis.
      for (const slot of Object.values(
        config.slots ?? { active: { unit: config.unit } },
      ))
        stop({ ...config, unit: slot.unit });
      await durable(path, {
        ...(await json(path)),
        containment: "applications-stopped",
        proxyFailure: error.message,
      });
    }
  }
}
async function verifyBaseline(config, commit) {
  assert.equal(
    (await json(resolve(config.current, "release.json"))).commit,
    commit,
  );
  const pid = command(
    "/bin/systemctl",
    "show",
    config.unit,
    "--property=MainPID",
    "--value",
  ).trim();
  assert.match(pid, /^[1-9][0-9]*$/);
  const cwd = await readlink(`/proc/${pid}/cwd`);
  assert.equal(
    (await json(resolve(cwd, "release.json"))).commit,
    commit,
    "BASELINE_PROCESS_MISMATCH",
  );
  if (
    await exists(
      resolve(config.current, "build/server/interfaces/http/readiness.js"),
    )
  ) {
    await probe(config, commit, config.slots[config.activeSlot].port);
  } else {
    // First adoption may restore the verified pre-readiness application.
    // Bind that process to its archived code, then check its existing contracts.
    for (const [path, expected] of [
      ["/login", 200],
      ["/.well-known/oauth-authorization-server", 200],
      ["/oauth/authorize", 400],
    ]) {
      const response = await fetch(new URL(path, config.probeUrl), {
        signal: AbortSignal.timeout(5000),
        headers: {
          Host: new URL(config.ingressUrl).host,
          "X-Forwarded-Proto": new URL(config.ingressUrl).protocol.slice(0, -1),
        },
      });
      assert.equal(response.status, expected);
    }
    for (const permission of ["-r", "-w", "-x"])
      command(
        "/usr/sbin/runuser",
        "-u",
        config.serviceUser,
        "--",
        "/usr/bin/test",
        permission,
        resolve(config.dataDir, "attachments"),
      );
  }
}
export async function recoverBeforeOpen(configPath, config, operation) {
  assert.ok(
    !operation.mayHaveOpenedAt && !operation.recoveryOpeningAt,
    "RESTORE_AFTER_OPEN_FORBIDDEN",
  );
  const statePath = resolve(
    config.stateDir,
    "operations",
    `${operation.id}.json`,
  );
  await maintenance(config, true);
  for (const slot of Object.values(config.slots))
    stop({ ...config, unit: slot.unit });
  const old = slotConfig(config, operation.target.oldSlot);
  if (operation.localBackup === "verified") {
    operation = {
      ...operation,
      phase: "rolling-back",
      recoveryId: randomUUID(),
    };
    await durable(statePath, operation);
    command(
      "/usr/bin/flock",
      "--nonblock",
      config.dataLock,
      process.execPath,
      fileURLToPath(new URL("./data-worker.mjs", import.meta.url)),
      resolve(configPath),
      operation.id,
      "rollback",
    );
    operation = await json(statePath);
  } else {
    assert.ok(
      ["stopping", "data-operation"].includes(operation.phase),
      "UNKNOWN_DATA_STAGE",
    );
  }
  const token = (await readFile(config.healthTokenFile, "utf8")).trim();
  await durable(
    old.slots[old.activeSlot].envFile,
    `PORT=${old.slots[old.activeSlot].port}\nDAILY_HEALTH_TOKEN=${token}\n`,
  );
  await start(old);
  await verifyBaseline(old, operation.target.oldCommit);
  await durable(
    config.upstreamFile,
    `server 127.0.0.1:${old.slots[old.activeSlot].port};\n`,
    0o644,
  );
  await reloadProxy();
  await durable(resolve(config.stateDir, "runtime.json"), {
    commit: operation.target.oldCommit,
    slot: old.activeSlot,
    artifact:
      operation.localBackup === "verified"
        ? (await configuration(configPath)).artifact
        : operation.target.oldArtifact,
  });
  operation = {
    ...operation,
    phase: "rollback-may-be-open",
    recoveryOpeningAt: new Date().toISOString(),
  };
  await durable(statePath, operation);
  await maintenance(config, false);
  if (
    await exists(
      resolve(config.current, "build/server/interfaces/http/readiness.js"),
    )
  )
    await externalProbe(config, operation.target.oldCommit);
  return {
    ...operation,
    actualCommit: operation.target.oldCommit,
    slot: old.activeSlot,
    recovery: "baseline-restored",
  };
}

export async function observe(config, operation, expectedCommit) {
  let failure;
  try {
    await externalProbe(config, expectedCommit);
  } catch (error) {
    failure = error.message;
  }
  let dataError = false;
  try {
    const response = await fetch(new URL("/internal/health", config.probeUrl), {
      headers: {
        "X-Daily-Health": (
          await readFile(config.healthTokenFile, "utf8")
        ).trim(),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 503) dataError = true;
  } catch {
    /* Unreachable is assessed by repeated public readiness failures. */
  }
  if (!failure && !dataError) {
    await durable(resolve(config.stateDir, "availability.json"), {
      commit: expectedCommit,
      failures: 0,
    });
    return {
      healthy: true,
      frozen: await exists(resolve(config.stateDir, "incident.json")),
    };
  }
  await freeze(
    config,
    operation,
    dataError ? "DATA_HEALTH_FAILED" : failure,
    false,
  );
  let ready = false;
  try {
    const r = await fetch(new URL("/health/ready", config.ingressUrl), {
      signal: AbortSignal.timeout(5000),
    });
    const body = await r.json();
    ready = r.ok && body.ready === true && body.version === expectedCommit;
  } catch {
    /* Count unavailable readiness below. */
  }
  const path = resolve(config.stateDir, "availability.json");
  const previous = (await exists(path)) ? await json(path) : {};
  const same = previous.commit === expectedCommit && previous.failures > 0;
  const record = {
    commit: expectedCommit,
    failures: ready ? 0 : (same ? previous.failures : 0) + 1,
    firstFailureAt: ready ? null : same ? previous.firstFailureAt : Date.now(),
    lastFailureAt: Date.now(),
  };
  await durable(path, record);
  const sustained =
    record.failures >= 3 && Date.now() - record.firstFailureAt >= 60000;
  if (dataError || sustained) await maintenance(config, true);
  return {
    healthy: false,
    reason: dataError ? "DATA_HEALTH_FAILED" : failure,
    maintenance: dataError || sustained,
    ...record,
  };
}

export async function resolveIncident(config, operation) {
  const incidentPath = resolve(config.stateDir, "incident.json");
  const incident = await json(incidentPath);
  assert.equal(incident.id, operation.incident, "INCIDENT_CHANGED");
  assert.match(operation.expectedCommit, /^[a-f0-9]{40}$/);
  assert.ok(operation.note?.trim(), "MANUAL_RESOLUTION_NOTE_REQUIRED");
  for (const [slot, settings] of Object.entries(config.slots))
    if (slot !== config.activeSlot) assertStopped(settings.unit);
  await start(config);
  await verifyBaseline(config, operation.expectedCommit);
  // No data restore here: the operator repairs the current version/data first.
  operation = {
    ...operation,
    phase: "resolution-may-be-open",
    mayHaveOpenedAt: new Date().toISOString(),
  };
  await durable(
    resolve(config.stateDir, "operations", `${operation.id}.json`),
    operation,
  );
  await maintenance(config, false);
  await externalProbe(config, operation.expectedCommit);
  await mkdir(resolve(config.stateDir, "incidents"), {
    recursive: true,
    mode: 0o700,
  });
  await durable(resolve(config.stateDir, "incidents", `${operation.id}.json`), {
    ...incident,
    resolvedBy: operation.id,
    note: operation.note,
    resolvedAt: new Date().toISOString(),
  });
  await rm(incidentPath);
  await durable(resolve(config.stateDir, "availability.json"), {
    commit: operation.expectedCommit,
    failures: 0,
  });
  return operation;
}
