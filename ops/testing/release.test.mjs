import assert from "node:assert/strict";
import { test } from "node:test";
import {
  writeFile,
  readFile,
  mkdir,
  symlink,
  access,
  chmod,
} from "node:fs/promises";
import { run } from "./fixture.mjs";
import { slotsFixture } from "./slots-fixture.mjs";
import { randomBytes, randomUUID, createHash } from "node:crypto";

test("verified release switches real slots with one writer and preserved member data", async (t) => {
  const f = await slotsFixture(t);
  const baseline = JSON.parse(
    await readFile(`${f.root}/current/release.json`, "utf8"),
  ).commit;
  const target = JSON.parse(
    await readFile("/candidate-artifact/receipt.json", "utf8"),
  ).commit;
  const rejected = await f.control(
    "release",
    "--id",
    "stale",
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    "0".repeat(40),
  );
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.output, /BASELINE_CHANGED/);
  assert.equal((await fetch(f.origin + "/login")).status, 200);
  const verifier = randomBytes(32).toString("base64url");
  const scopes = ["progress:read", "drafts:write"];
  const authRequest = {
    client_id: "daily-flow-codex",
    redirect_uri: "http://127.0.0.1:19876/callback",
    resource: f.origin + "/mcp",
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    scope: scopes.join(" "),
    state: "isolated-state",
  };
  const approval = await f.request("/api/ai/authorize", {
    request: authRequest,
    scopes,
    approve: true,
  });
  const token = await fetch(f.origin + "/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: authRequest.client_id,
      redirect_uri: authRequest.redirect_uri,
      resource: authRequest.resource,
      code: new URL(approval.redirect).searchParams.get("code"),
      code_verifier: verifier,
    }),
  }).then((r) => r.json());
  const draft = {
    operationId: randomUUID(),
    title: "切换时重试",
    entries: [{ id: randomUUID(), body: "MCP 保留回执" }],
  };
  const call = async () => {
    const r = await fetch(f.origin + "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_draft", arguments: draft },
      }),
    });
    assert.equal(r.status, 200);
    const result = await r.json();
    assert.ok(!result.result.isError, JSON.stringify(result));
    return result.result.structuredContent;
  };
  const created = await call();
  // Pause a different operation at the file-lock boundary, after it has read
  // blue's configuration. It must use green when resumed after this release.
  const hook = `${f.root}/pause-backup.mjs`;
  await writeFile(
    hook,
    `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.open;
fs.open = async function(path,...args) { if(String(path).endsWith('/operation.lock')) {
await fs.writeFile(${JSON.stringify(`${f.root}/paused`)}, 'ready');
while(true) { try { await fs.access(${JSON.stringify(`${f.root}/resume`)}); break; } catch { await new Promise(r=>setTimeout(r,20)); } }
} return original.call(this,path,...args); }; syncBuiltinESMExports();`,
  );
  const delayed = f.controlWith(
    ["--import", hook],
    "backup",
    "--id",
    "delayed-backup",
  );
  t.after(async () => {
    await writeFile(`${f.root}/resume`, "resume");
    await delayed;
  });
  for (let i = 0; i < 100; i++) {
    try {
      await access(`${f.root}/paused`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  await access(`${f.root}/paused`);
  const running = f.control(
    "release",
    "--id",
    "switch-green",
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    baseline,
  );
  let maintenanceSeen = false;
  for (let n = 0; n < 600; n++) {
    const r = await fetch(f.origin + "/login");
    if (r.status === 503) {
      maintenanceSeen = true;
      assert.equal(r.headers.get("retry-after"), "60");
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(maintenanceSeen);
  for (const path of ["/api/diaries", "/public/test", "/mcp"])
    assert.equal((await fetch(f.origin + path)).status, 503);
  const result = await running;
  assert.equal(result.code, 0, result.output + result.error);
  const receipt = JSON.parse(result.output);
  assert.equal(receipt.actualCommit, target);
  assert.equal(receipt.slot, "green");
  const replayed = await call();
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.diary.id, created.diary.id);
  assert.ok(receipt.mayHaveOpenedAt && receipt.maintenanceMilliseconds > 0);
  assert.equal(
    run(
      "systemctl",
      "show",
      f.config.unit,
      "--property=MainPID",
      "--value",
    ).trim(),
    "0",
  );
  assert.equal(
    run("systemctl", "is-active", f.config.slots.green.unit).trim(),
    "active",
  );
  assert.deepEqual(
    await fetch(f.origin + "/health/ready").then((r) => r.json()),
    { ready: true, version: target },
  );
  assert.equal(
    (
      await fetch(f.origin + "/internal/health", {
        headers: {
          "X-Daily-Health": "isolated_health_token_012345678901234567890",
        },
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
  assert.equal(
    await f.request(`/api/attachments/${f.attachment}`, undefined, true),
    "original attachment bytes",
  );
  assert.equal(
    JSON.parse(
      await readFile(`${f.root}/backups/switch-green/manifest.json`, "utf8"),
    ).commit,
    baseline,
  );
  const retry = await f.control(
    "release",
    "--id",
    "switch-green",
    "--candidate",
    "/candidate-artifact",
    "--baseline",
    baseline,
  );
  const retried = JSON.parse(retry.output);
  assert.ok(retried.offsite.ageMilliseconds >= receipt.offsite.ageMilliseconds);
  assert.deepEqual(
    { ...retried, offsite: { ...retried.offsite, ageMilliseconds: 0 } },
    { ...receipt, offsite: { ...receipt.offsite, ageMilliseconds: 0 } },
  );
  await writeFile(`${f.root}/resume`, "resume");
  const backupAfter = await delayed;
  assert.equal(backupAfter.code, 0, backupAfter.output + backupAfter.error);
  assert.equal(
    JSON.parse(
      await readFile(`${f.root}/backups/delayed-backup/manifest.json`, "utf8"),
    ).commit,
    target,
  );
  await chmod(`${f.root}/data/attachments`, 0o000);
  try {
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${f.config.slots.green.port}/internal/health`,
          {
            headers: {
              "X-Daily-Health": "isolated_health_token_012345678901234567890",
            },
          },
        )
      ).status,
      503,
      "Deep health must test access as the ordinary application user",
    );
  } finally {
    await chmod(`${f.root}/data/attachments`, 0o755);
  }
});
