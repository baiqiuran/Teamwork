import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  chmod,
  readdir,
  readFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { json, durable, sha256, syncPath } from "./io.mjs";
import { capacity, exists } from "./host.mjs";
import { validate } from "./snapshots.mjs";
import { withControlLock } from "./retention.mjs";
import { verifyPublicBaseline } from "./recovery.mjs";

function isolated(config, id) {
  assert.match(id, /^[a-zA-Z0-9_-]{1,80}$/);
  assert.equal(
    config.recoveryMode,
    "isolated",
    "RECOVERY_REQUIRES_ISOLATED_HOST",
  );
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(
      new URL(config.ingressUrl).hostname,
    ),
    "RECOVERY_REQUIRES_LOOPBACK_INGRESS",
  );
}
export async function pullSnapshot(config, store, id) {
  isolated(config, id);
  return withControlLock(config, `pull-${id}`, async () => {
    await store.check();
    const token = await store.lock();
    const recordPath = resolve(config.stateDir, "drills", `${id}.json`);
    await mkdir(resolve(config.stateDir, "drills"), {
      recursive: true,
      mode: 0o700,
    });
    let record = (await exists(recordPath))
      ? await json(recordPath)
      : {
          id,
          startedAt: new Date().toISOString(),
          pin: `restore-pin-${randomUUID()}.json`,
        };
    try {
      if (record.phase === "fetched" || record.phase === "verified")
        return record;
      record = { ...record, phase: "fetching" };
      await durable(recordPath, record);
      await store.put(
        `${config.oss.prefix}${id}/${record.pin}`,
        Buffer.from(JSON.stringify({ startedAt: record.startedAt })),
      );
      const stage = await mkdtemp(resolve(config.backupDir, ".remote-"));
      await store.get(
        `${config.oss.prefix}${id}/complete.json`,
        resolve(stage, "complete.json"),
      );
      const marker = await json(resolve(stage, "complete.json"));
      assert.equal(marker.id, id);
      await store.get(
        `${config.oss.prefix}${id}/manifest.json`,
        resolve(stage, "manifest.json"),
      );
      assert.equal(
        await sha256(resolve(stage, "manifest.json")),
        marker.manifestDigest,
        "REMOTE_MANIFEST_MISMATCH",
      );
      const manifest = await json(resolve(stage, "manifest.json"));
      assert.equal(manifest.id, id);
      const names = ["application.tar.gz", "config.env", "data.tar.gz", "node"];
      assert.deepEqual(manifest.materials.map((f) => f.name).sort(), names);
      assert.deepEqual(
        marker.files.map((f) => f.name).sort(),
        [...names, "manifest.json", "manifest.sha256"].sort(),
      );
      await capacity(
        config,
        manifest.materials.reduce((sum, f) => {
          assert.ok(Number.isSafeInteger(f.bytes) && f.bytes >= 0);
          return sum + f.bytes;
        }, 0) * 2,
      );
      for (const file of marker.files) {
        await store.get(
          `${config.oss.prefix}${id}/${file.name}`,
          resolve(stage, file.name),
        );
        await chmod(resolve(stage, file.name), 0o600);
        assert.equal(
          await sha256(resolve(stage, file.name)),
          file.sha256,
          "REMOTE_MATERIAL_MISMATCH",
        );
        await syncPath(resolve(stage, file.name));
      }
      const checked = await validate(config, stage);
      await rm(checked, { recursive: true, force: true });
      await rm(resolve(stage, "complete.json"));
      const target = resolve(config.backupDir, id);
      if (await exists(target)) {
        assert.equal(
          await sha256(resolve(target, "manifest.json")),
          marker.manifestDigest,
          "RECOVERY_POINT_CONFLICT",
        );
        const existing = await validate(config, target);
        await rm(existing, { recursive: true, force: true });
        await rm(stage, { recursive: true, force: true });
      } else await rename(stage, target);
      await syncPath(config.backupDir);
      record = {
        ...record,
        phase: "fetched",
        snapshotAt: manifest.snapshotAt,
        commit: manifest.commit,
        manifestDigest: marker.manifestDigest,
        fetchedAt: new Date().toISOString(),
      };
      await durable(recordPath, record);
      return record;
    } catch (error) {
      await durable(recordPath, {
        ...record,
        phase: "failed",
        failure: "REMOTE_RECOVERY_MATERIALS_FAILED",
        failedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      await store.unlock(token);
    }
  });
}
function businessRows(database, table) {
  return database
    .prepare(`SELECT * FROM "${table}"`)
    .all()
    .map((row) => {
      if (table === "ai_grants") delete row.last_used_at;
      return JSON.stringify(row);
    })
    .sort();
}
export async function verifyDrill(config, store, id) {
  isolated(config, id);
  return withControlLock(config, `drill-${id}`, async () => {
    const path = resolve(config.stateDir, "drills", `${id}.json`);
    let record = await json(path),
      stage;
    try {
      assert.ok(
        ["fetched", "failed"].includes(record.phase),
        "DRILL_NOT_READY",
      );
      const operations = await Promise.all(
        (await readdir(resolve(config.stateDir, "operations")))
          .filter((n) => n.endsWith(".json"))
          .map((n) => json(resolve(config.stateDir, "operations", n))),
      );
      assert.ok(
        operations.some(
          (o) =>
            o.command === "restore" &&
            o.snapshot === id &&
            o.phase === "completed" &&
            Date.parse(o.createdAt) >= Date.parse(record.startedAt),
        ),
        "MATCHED_RESTORE_NOT_COMPLETED",
      );
      const manifest = await json(
        resolve(config.backupDir, id, "manifest.json"),
      );
      assert.equal(
        (await json(resolve(config.current, "release.json"))).commit,
        manifest.commit,
      );
      stage = await validate(config, resolve(config.backupDir, id));
      const expected = new DatabaseSync(resolve(stage, config.database), {
        readOnly: true,
      });
      const actual = new DatabaseSync(
        resolve(config.dataDir, config.database),
        { readOnly: true },
      );
      const checks = {};
      try {
        for (const table of [
          "team",
          "members",
          "diaries",
          "projects",
          "tasks",
          "shares",
          "attachments",
          "sessions",
          "invitations",
          "task_events",
          "diary_events",
          "submission_receipts",
          "ai_grants",
          "ai_refresh",
          "ai_receipts",
        ]) {
          const rows = businessRows(expected, table);
          assert.ok(
            JSON.stringify(businessRows(actual, table)) ===
              JSON.stringify(rows),
            `RECOVERY_CONTENT_MISMATCH: ${table}`,
          );
          checks[table] = { verified: true, rows: rows.length };
        }
      } finally {
        expected.close();
        actual.close();
      }
      for (const file of manifest.files.filter((f) =>
        f.path.startsWith("attachments/"),
      ))
        assert.equal(
          await sha256(resolve(config.dataDir, file.path)),
          file.sha256,
          "RECOVERY_ATTACHMENT_MISMATCH",
        );
      await verifyPublicBaseline(config, manifest.commit);
      record = {
        ...record,
        phase: "verified",
        finishedAt: new Date().toISOString(),
        checks,
        attachmentsVerified: true,
        protocolsVerified: true,
        recoveryMilliseconds: Date.now() - Date.parse(record.startedAt),
        recoveryPointMilliseconds:
          Date.parse(record.startedAt) - Date.parse(manifest.snapshotAt),
      };
      record.withinRto = record.recoveryMilliseconds <= 14400000;
      record.withinRpo = record.recoveryPointMilliseconds <= 86400000;
      await durable(path, record);
      await durable(resolve(config.stateDir, "latest-drill.json"), record);
      await store.check();
      await store.remove(`${config.oss.prefix}${id}/${record.pin}`);
      return record;
    } catch (error) {
      record = {
        ...record,
        phase: "failed",
        failure: "RECOVERY_VERIFICATION_FAILED",
        failedAt: new Date().toISOString(),
      };
      await durable(path, record);
      await durable(resolve(config.stateDir, "latest-drill.json"), record);
      throw error;
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true });
    }
  });
}
