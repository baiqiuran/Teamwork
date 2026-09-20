// Forced SSH command. Root-owned code/config; callers provide IDs, never paths.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configuration, command, exists, capacity } from "./host.mjs";
import { json, sha256, syncPath, durable } from "./io.mjs";
import { archiveSize, extract } from "./snapshots.mjs";
import { status as backupStatus } from "./offsite.mjs";
import { externalProbe } from "./release.mjs";
async function main() {
  const [flag, path, commandFlag, original] = process.argv.slice(2);
  assert.equal(flag, "--config");
  assert.equal(commandFlag, "--command");
  assert.ok(
    typeof original === "string" && /^[a-zA-Z0-9 _-]+$/.test(original),
    "INVALID_REMOTE_COMMAND",
  );
  const [action, id, value, ...extra] = original.split(" ");
  assert.equal(extra.length, 0);
  const config = await configuration(path);
  const internal = (script) => fileURLToPath(new URL(script, import.meta.url));
  const run = (script, ...args) =>
    command(
      process.execPath,
      internal(script),
      "--config",
      resolve(path),
      ...args,
    );
  async function summary(result) {
    const runtime = await json(resolve(config.stateDir, "runtime.json"));
    return {
      id: result.id,
      phase: result.phase,
      actualCommit: result.actualCommit ?? runtime.commit,
      runningCommit: runtime.commit,
      snapshotCommit: result.commit,
      slot: result.slot,
      recovery: result.recovery,
      backup: result.offsite,
      maintenanceMilliseconds: result.maintenanceMilliseconds,
      failed: result.phase === "failed",
    };
  }
  if (action === "baseline") {
    assert.ok(!id && !value);
    const runtime = await json(resolve(config.stateDir, "runtime.json"));
    const lock = (await exists(resolve(config.stateDir, "operation.lock")))
      ? await json(resolve(config.stateDir, "operation.lock"))
      : null;
    console.log(
      JSON.stringify({
        commit: runtime.commit,
        slot: runtime.slot,
        backup: config.oss
          ? await backupStatus(config)
          : { backup: "not-configured" },
        busy: !!lock,
        operationId: lock?.id,
        frozen: await exists(resolve(config.stateDir, "incident.json")),
        incidentId: (await exists(resolve(config.stateDir, "incident.json")))
          ? (await json(resolve(config.stateDir, "incident.json"))).id
          : undefined,
        enabled: config.automationEnabled === true,
      }),
    );
  } else {
    assert.match(id ?? "", /^[a-zA-Z0-9_-]{1,80}$/);
    if (
      ["inspect", "inspection-complete", "external-failure"].includes(action)
    ) {
      assert.ok(!value);
      // Diagnosis failures are data: preserve their sanitized report for Actions.
      try {
        process.stdout.write(
          run(
            "./monitor.mjs",
            action === "inspection-complete" ? "complete" : action,
            id,
          ),
        );
      } catch (error) {
        if (!error.stdout) throw error;
        process.stdout.write(String(error.stdout));
        process.exitCode = 1;
      }
    } else if (action === "status") {
      assert.ok(!value);
      const operation = resolve(config.stateDir, "operations", `${id}.json`),
        request = resolve(config.stateDir, "requests", `${id}.json`);
      if (!(await exists(operation)) && !(await exists(request))) {
        const uploaded = config.incoming && resolve(config.incoming, id);
        if (uploaded && (await exists(uploaded))) {
          const receipt = await json(resolve(uploaded, "receipt.json")),
            proof = await json(resolve(uploaded, "upgrade.json"));
          console.log(
            JSON.stringify({
              id,
              phase: "uploaded",
              actualCommit: receipt.commit,
              baseline: proof.from,
              artifactSha256: receipt.sha256,
            }),
          );
        } else console.log(JSON.stringify({ id, phase: "absent" }));
      } else
        console.log(
          JSON.stringify(
            await summary(
              JSON.parse(run("./control.mjs", "status", "--id", id)),
            ),
          ),
        );
    } else {
      assert.ok(
        config.incoming && resolve(config.incoming) === config.incoming,
        "INCOMING_PATH_REQUIRED",
      );
      const target = resolve(config.incoming, id);
      if (action === "upload") {
        assert.match(value ?? "", /^[a-f0-9]{64}$/);
        await mkdir(config.incoming, { recursive: true, mode: 0o700 });
        await capacity(config, 1073741824);
        const stage = await mkdtemp(resolve(config.incoming, ".upload-")),
          archive = resolve(stage, "bundle.tar.gz");
        try {
          const file = await open(archive, "wx", 0o600);
          let bytes = 0;
          try {
            for await (const chunk of process.stdin) {
              bytes += chunk.length;
              assert.ok(bytes <= 536870912, "UPLOAD_TOO_LARGE");
              await file.writeFile(chunk);
            }
            await file.sync();
          } finally {
            await file.close();
          }
          assert.equal(await sha256(archive), value, "UPLOAD_DIGEST_MISMATCH");
          await capacity(config, archiveSize(archive) * 2, [stage]);
          const names = command("/usr/bin/tar", "-tzf", archive)
            .trim()
            .split("\n")
            .sort();
          assert.deepEqual(names, [
            "application.tar.gz",
            "plan.json",
            "receipt.json",
            "upgrade.json",
          ]);
          const content = resolve(stage, "content");
          await mkdir(content, { mode: 0o700 });
          extract(archive, content);
          const receipt = await json(resolve(content, "receipt.json"));
          assert.equal(
            await sha256(resolve(content, "application.tar.gz")),
            receipt.sha256,
          );
          await durable(resolve(content, "bundle.sha256"), value);
          if (await exists(target))
            assert.equal(
              (await readFile(resolve(target, "bundle.sha256"), "utf8")).trim(),
              value,
              "UPLOAD_ID_CONFLICT",
            );
          else {
            await rename(content, target);
            await syncPath(config.incoming);
          }
          console.log(
            JSON.stringify({ id, phase: "uploaded", commit: receipt.commit }),
          );
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      } else if (action === "release") {
        assert.match(value ?? "", /^[a-f0-9]{40}$/);
        assert.equal(config.automationEnabled, true, "AUTOMATION_DISABLED");
        const receipt = await json(resolve(target, "receipt.json"));
        assert.match(receipt.commit, /^[a-f0-9]{40}$/);
        assert.ok(
          config.repository && resolve(config.repository) === config.repository,
          "TRUSTED_REPOSITORY_REQUIRED",
        );
        const git = (...args) =>
          command("/usr/bin/git", "--git-dir", config.repository, ...args);
        git(
          "fetch",
          "--no-tags",
          "origin",
          "+refs/heads/main:refs/remotes/origin/main",
        );
        git(
          "merge-base",
          "--is-ancestor",
          receipt.commit,
          "refs/remotes/origin/main",
        );
        git("merge-base", "--is-ancestor", value, receipt.commit);
        const current = await json(resolve(config.stateDir, "runtime.json"));
        if (
          (await exists(
            resolve(config.stateDir, "operations", `${id}.json`),
          )) ||
          (await exists(resolve(config.stateDir, "requests", `${id}.json`)))
        ) {
          console.log(
            JSON.stringify(
              await summary(
                JSON.parse(run("./control.mjs", "status", "--id", id)),
              ),
            ),
          );
          return;
        }
        if (await exists(resolve(config.stateDir, "operation.lock"))) {
          console.log(JSON.stringify({ id, phase: "busy" }));
          return;
        }
        if (current.commit === receipt.commit) {
          assert.ok(
            !(await exists(resolve(config.stateDir, "incident.json"))),
            "INCIDENT_REQUIRES_MANUAL_RESOLUTION",
          );
          await externalProbe(config, current.commit);
          console.log(
            JSON.stringify({
              id,
              phase: "completed",
              actualCommit: current.commit,
              slot: current.slot,
              recovery: "already-current",
            }),
          );
        } else {
          assert.equal(current.commit, value, "BASELINE_CHANGED");
          if (await exists(resolve(config.stateDir, "operation.lock"))) {
            console.log(JSON.stringify({ id, phase: "busy" }));
            return;
          }
          const state = JSON.parse(
            run(
              "./dispatch.mjs",
              "release",
              "--id",
              id,
              "--candidate",
              target,
              "--baseline",
              value,
            ),
          );
          console.log(JSON.stringify(await summary(state)));
        }
      } else throw new Error("REMOTE_COMMAND_NOT_ALLOWED");
    }
  }
}
await main().catch((error) => {
  const detail = String(error.message) + " " + String(error.stderr ?? "");
  const code =
    [
      "BASELINE_CHANGED",
      "AUTOMATION_DISABLED",
      "OPERATION_BUSY",
      "UPLOAD_ID_CONFLICT",
      "UPLOAD_DIGEST_MISMATCH",
      "UPLOAD_TOO_LARGE",
      "INSUFFICIENT_DISK",
      "OFFSITE_BACKUP_EXPIRED_OR_MISSING",
    ].find((x) => detail.includes(x)) ?? "REMOTE_OPERATION_REJECTED";
  console.log(JSON.stringify({ phase: "rejected", error: code }));
  process.exitCode = 1;
});
