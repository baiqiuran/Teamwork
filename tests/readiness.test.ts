import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./support.ts";

test("发布就绪信息不泄露业务信息，深度检查需要本机专用凭证", async (t) => {
  const version = "a".repeat(40);
  const f = await fixture(t, {
    releaseCommit: version,
    healthToken: "isolated-health-token",
  });
  const publicResponse = await fetch(f.origin + "/health/ready");
  assert.equal(publicResponse.status, 200);
  assert.deepEqual(await publicResponse.json(), { ready: true, version });
  assert.equal((await fetch(f.origin + "/internal/health")).status, 404);
  assert.equal(
    (
      await fetch(f.origin + "/internal/health", {
        headers: { "X-Daily-Health": "wrong" },
      })
    ).status,
    404,
  );
  const deep = await fetch(f.origin + "/internal/health", {
    headers: { "X-Daily-Health": "isolated-health-token" },
  });
  assert.equal(deep.status, 200);
  const detail = await deep.json();
  assert.equal(detail.ready, true);
  assert.equal(detail.version, version);
  assert.equal(detail.integrity, "ok");
  assert.ok(Number.isInteger(detail.schema));
  assert.deepEqual(Object.keys(detail).sort(), [
    "attachmentsAccessible",
    "initialized",
    "integrity",
    "ready",
    "schema",
    "version",
  ]);
});
