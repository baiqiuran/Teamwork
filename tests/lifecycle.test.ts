import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./application.ts";

test("应用实例隔离身份与时钟，监听失败及重复关闭后仍能重新启动", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "daily-lifecycle-"));
  const instances: Awaited<ReturnType<typeof createApp>>[] = [];
  t.after(async () => {
    await Promise.all(instances.map((service) => service.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const time = Date.parse("2026-09-16T04:00:00Z");
  const invalidDatabase = join(directory, "invalid.sqlite");
  await writeFile(invalidDatabase, "This is not a SQLite database");
  await assert.rejects(
    createApp({ databasePath: invalidDatabase }),
  );
  // A failed database initialization must release its file handle as well.
  await rm(invalidDatabase);
  async function start(name: string, now = time) {
    const service = await createApp({
      databasePath: join(directory, name + ".sqlite"),
      now: () => now,
      staticDirectory: join(directory, "missing-site"),
    });
    instances.push(service);
    const server = await service.listen(0);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return {
      service,
      port: address.port,
      origin: `http://127.0.0.1:${address.port}`,
    };
  }
  const first = await start("first"),
    second = await start("second");
  const recovered = await start("invalid");
  assert.equal(
    (await (await fetch(recovered.origin + "/api/setup/status")).json())
      .needsSetup,
    true,
  );
  const created = await fetch(first.origin + "/api/setup", {
    method: "POST",
    headers: { Origin: first.origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "隔离成员",
      email: "isolated@example.test",
      password: "IsolatedMember2026!",
      teamName: "独立团队",
    }),
  });
  assert.equal(created.status, 201);
  const cookie = created.headers.get("set-cookie")!.split(";")[0];
  assert.equal(
    (await fetch(second.origin + "/api/me", { headers: { Cookie: cookie } }))
      .status,
    401,
  );
  assert.equal(
    (await (await fetch(second.origin + "/api/setup/status")).json())
      .needsSetup,
    true,
  );
  const page = await fetch(first.origin + "/login");
  assert.equal(page.status, 503);
  assert.equal(await page.text(), "请先运行 npm run build。");
  const unknown = await fetch(first.origin + "/api/not-found");
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "未找到该接口。" });
  const uppercaseUnknown = await fetch(first.origin + "/API/not-found");
  assert.equal(uppercaseUnknown.status, 404);
  assert.deepEqual(await uppercaseUnknown.json(), { error: "未找到该接口。" });
  const failed = await createApp({
    databasePath: join(directory, "failed.sqlite"),
  });
  instances.push(failed);
  await assert.rejects(failed.listen(first.port), { code: "EADDRINUSE" });
  await Promise.all([failed.close(), failed.close()]);
  const retry = await start("failed");
  assert.equal(
    (await (await fetch(retry.origin + "/api/setup/status")).json()).needsSetup,
    true,
  );
  await Promise.all([first.service.close(), first.service.close()]);
  const restarted = await start("first");
  assert.equal(
    (await fetch(restarted.origin + "/api/me", { headers: { Cookie: cookie } }))
      .status,
    200,
  );
  await restarted.service.close();
  const expired = await start("first", time + 7 * 24 * 60 * 60 * 1000);
  assert.equal(
    (await fetch(expired.origin + "/api/me", { headers: { Cookie: cookie } }))
      .status,
    401,
  );
});
