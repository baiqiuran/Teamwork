import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("编译后的服务由 Node 启动，成员可初始化、退出并重新登录", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "daily-runtime-"));
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => reservation.close(() => done()));
  const origin = `http://127.0.0.1:${address.port}`;
  const environment = { ...process.env };
  // This is an application process, not another node:test worker.
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [resolve("build/server/main.js")], {
    env: {
      ...environment,
      PORT: String(address.port),
      DAILY_DATABASE_PATH: join(directory, "runtime.sqlite"),
      DAILY_SETUP_KEY: "runtime-test-key",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((ready, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Startup timeout: ${output}`)),
      15000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(output));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("日序已启动")) {
        clearTimeout(timer);
        ready();
      }
    });
  });
  let cookie = "";
  async function request(path: string, body?: object) {
    const response = await fetch(`${origin}/api${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const nextCookie = response.headers.get("set-cookie");
    if (nextCookie) cookie = nextCookie.split(";")[0];
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
    };
  }
  assert.equal((await request("/setup/status")).body.needsSetup, true);
  const credentials = {
    email: "compiled@example.test",
    password: "CompiledRuntime2026!",
  };
  const setup = await request("/setup", {
    ...credentials,
    name: "编译用户",
    teamName: "编译团队",
    setupKey: "runtime-test-key",
  });
  assert.equal(setup.status, 201);
  assert.match(setup.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.equal((await request("/me")).body.member.name, "编译用户");
  assert.equal((await request("/logout", {})).status, 200);
  assert.equal((await request("/me")).status, 401);
  assert.equal((await request("/login", credentials)).status, 200);
  assert.equal((await request("/me")).body.member.id, setup.body.member.id);
  const malformed = await fetch(`${origin}/api/diaries`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "请求格式不正确。" });
  const missing = await request("/unknown-api");
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: "未找到该接口。" });
  assert.equal(missing.headers.get("cache-control"), "no-store");
});
