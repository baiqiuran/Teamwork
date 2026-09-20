import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readFile,
  writeFile,
  rm,
  mkdir,
  rename,
  access,
} from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { slotsFixture } from "./slots-fixture.mjs";
import { run } from "./fixture.mjs";
import { offsite } from "./offsite-client.mjs";

test("isolated recovery uses only remote materials and proves business, attachments and authorization persistence", async (t) => {
  const f = await slotsFixture(t),
    path = `${f.root}/deploy.json`;
  const project = await f.request("/api/projects", {
    name: "恢复项目",
    description: "",
  });
  const task = await f.request(`/api/projects/${project.id}/tasks`, {
    name: "恢复任务",
    description: "",
  });
  const share = await f.request("/api/shares", {
    type: "diary",
    from: "2026-09-01",
    to: "2026-09-30",
    modules: ["progress"],
  });
  const verifier = randomBytes(32).toString("base64url"),
    scopes = ["progress:read"];
  const request = {
    client_id: "daily-flow-codex",
    redirect_uri: "http://127.0.0.1:19876/callback",
    resource: f.origin + "/mcp",
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    scope: scopes.join(" "),
    state: "synthetic",
  };
  const approval = await f.request("/api/ai/authorize", {
    request,
    scopes,
    approve: true,
  });
  const token = await fetch(f.origin + "/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: request.client_id,
      redirect_uri: request.redirect_uri,
      resource: request.resource,
      code: new URL(approval.redirect).searchParams.get("code"),
      code_verifier: verifier,
    }),
  }).then((r) => r.json());
  let result = await f.control(
    "backup",
    "--id",
    "remote-only",
    "--kind",
    "daily",
  );
  assert.equal(result.code, 0, result.output + result.error);
  result = await offsite(path, "upload");
  assert.equal(result.code, 0, result.output + result.error);
  run("systemctl", "stop", f.config.unit);
  // Destroy only this synthetic fixture's source data/code/backups; the remote
  // boundary remains available. No original database participates in recovery.
  for (const directory of [
    f.config.dataDir,
    f.config.backupDir,
    f.config.releases,
  ]) {
    assert.ok(directory.startsWith("/srv/daily-test-"));
    await rm(directory, { recursive: true });
    await mkdir(directory);
  }
  await rm(f.config.envFile);
  f.config.recoveryMode = "isolated";
  await writeFile(path, JSON.stringify(f.config));
  const remoteConfig = `${f.root}/control/synthetic-oss/snapshots/remote-only/config.env`;
  await rename(remoteConfig, remoteConfig + ".saved");
  result = await offsite(path, "pull", "remote-only");
  assert.notEqual(result.code, 0);
  await assert.rejects(access(`${f.config.backupDir}/remote-only`));
  assert.equal(
    JSON.parse(
      await readFile(`${f.root}/control/drills/remote-only.json`, "utf8"),
    ).phase,
    "failed",
  );
  await rename(remoteConfig + ".saved", remoteConfig);
  result = await offsite(path, "pull", "remote-only");
  assert.equal(result.code, 0, result.output + result.error);
  result = await f.control(
    "restore",
    "--id",
    "restore-remote",
    "--snapshot",
    "remote-only",
  );
  assert.equal(result.code, 0, result.output + result.error);
  result = await offsite(path, "drill-verify", "remote-only");
  assert.equal(result.code, 0, result.output + result.error);
  const proof = JSON.parse(result.output);
  assert.equal(proof.phase, "verified");
  assert.equal(proof.withinRto, true);
  assert.equal(proof.withinRpo, true);
  assert.equal(proof.checks.projects.rows, 1);
  assert.equal(proof.checks.ai_grants.rows, 1);
  assert.equal(
    (await f.request(`/api/diaries/${f.diary.id}`)).published.entries[0].body,
    "恢复前的内容",
  );
  assert.equal(
    await f.request(`/api/attachments/${f.attachment}`, undefined, true),
    "original attachment bytes",
  );
  assert.ok(
    (await f.request(`/api/projects/${project.id}/tasks`)).some(
      (x) => x.id === task.id,
    ),
  );
  assert.ok((await f.request("/api/shares")).some((x) => x.id === share.id));
  const response = await fetch(f.origin + "/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 200);
});
