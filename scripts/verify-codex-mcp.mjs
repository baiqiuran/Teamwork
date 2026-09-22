import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { createApp } from "../build/server/app.js";

const binary = process.env.CODEX_TEST_BINARY;
if (!binary)
  throw new Error(
    "Set CODEX_TEST_BINARY to the Codex executable; uses isolated test credentials only.",
  );
const directory = await mkdtemp(join(tmpdir(), "daily-codex-"));
const appOptions = {
  databasePath: join(directory, "test.sqlite"),
  staticDirectory: resolve("dist"),
};
let app = await createApp(appOptions);
let processHandle, browser;
try {
  const listener = await app.listen(0),
    origin = `http://127.0.0.1:${listener.address().port}`;
  const credentials = {
    name: "MCP 验收成员",
    email: "codex@example.test",
    password: "CodexFixture2026!",
    teamName: "隔离验收团队",
  };
  const setup = await fetch(`${origin}/api/setup`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  assert.equal(setup.status, 201);
  const identity = await setup.json();
  const clientHome = join(directory, "codex");
  await mkdir(clientHome);
  await writeFile(
    join(clientHome, "config.toml"),
    `mcp_oauth_credentials_store = "file"\n[mcp_servers.daily_test]\nurl = "${origin}/mcp"\n[mcp_servers.daily_test.oauth]\nclient_id = "daily-flow-codex"\ncallback_url = "http://127.0.0.1/callback"\n`,
  );
  processHandle = spawn(binary, ["app-server"], {
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: clientHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let id = 0;
  let loginComplete;
  const loggedIn = new Promise((resolve) => {
    loginComplete = resolve;
  });
  createInterface({ input: processHandle.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const operation = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(operation.timer);
      message.error
        ? operation.reject(new Error(JSON.stringify(message.error)))
        : operation.resolve(message.result);
    }
    if (message.method === "mcpServer/oauthLogin/completed")
      loginComplete(message.params);
  });
  // Drain diagnostics without leaking authorization URLs or credentials.
  processHandle.stderr.on("data", (data) => {
    const safe = data
      .toString()
      .replace(/https?:\/\/[^\s]+/g, "[url]")
      .replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]");
    if (
      safe.includes("OAuth") ||
      safe.includes("oauth") ||
      safe.includes("ERROR")
    )
      console.error(safe);
  });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const key = ++id,
        timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`Codex ${method} timed out`));
        }, 45000);
      pending.set(key, { resolve, reject, timer });
      processHandle.stdin.write(
        JSON.stringify({ id: key, method, params }) + "\n",
      );
    });
  }
  await call("initialize", {
    clientInfo: { name: "daily_flow_acceptance", version: "1" },
    capabilities: { experimentalApi: true },
  });
  const login = await call("mcpServer/oauth/login", {
    name: "daily_test",
    scopes: [
      "progress:read",
      "drafts:write",
      "diaries:submit",
      "tasks:write",
      "shares:manage",
    ],
    timeoutSecs: 120,
  });
  const authorizationParameters = new URL(login.authorizationUrl).searchParams;
  // Register the exact callback emitted by this installed Codex version, as an
  // administrator would do before opening the authorization page. No wildcard.
  const registeredCallback = new URL(
    authorizationParameters.get("redirect_uri"),
  );
  registeredCallback.port = "";
  const servicePort = Number(new URL(origin).port);
  await app.close();
  app = await createApp({
    ...appOptions,
    codexRedirectUris: [registeredCallback.href],
  });
  await app.listen(servicePort);
  console.log("Codex authorization parameters", {
    keys: [...authorizationParameters.keys()],
    client: authorizationParameters.get("client_id"),
    redirectPath: new URL(authorizationParameters.get("redirect_uri")).pathname,
    scope: authorizationParameters.get("scope"),
    method: authorizationParameters.get("code_challenge_method"),
    challengeLength: authorizationParameters.get("code_challenge")?.length,
    stateLength: authorizationParameters.get("state")?.length,
    responseType: authorizationParameters.get("response_type"),
  });
  browser = await chromium.launch({
    channel:
      process.env.PLAYWRIGHT_CHANNEL === "chromium" ? undefined : "msedge",
    headless: true,
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/callback"))
      console.log("Callback parameter names", [...url.searchParams.keys()]);
  });
  const landing = await page.goto(login.authorizationUrl);
  if (landing?.status() !== 200)
    throw new Error(
      `Authorization page: ${landing?.status()} ${await page.locator("body").innerText()}`,
    );
  await page.getByLabel("邮箱", { exact: true }).fill(credentials.email);
  await page.getByLabel("密码", { exact: true }).fill(credentials.password);
  await page.getByLabel("密码", { exact: true }).press("Enter");
  await page
    .getByRole("heading", { name: "允许 Codex 为你处理工作" })
    .waitFor();
  assert.equal(await page.getByLabel("查询团队工作进展").isChecked(), true);
  assert.equal(await page.getByLabel("读写本人日报草稿").isChecked(), true);
  assert.equal(await page.getByLabel("提交本人日报").isChecked(), false);
  assert.equal(
    await page.getByLabel("创建任务和更新任务状态").isChecked(),
    false,
  );
  assert.equal(
    await page.getByLabel("创建和关闭本人公开链接").isChecked(),
    false,
  );
  for (const label of [
    "提交本人日报",
    "创建任务和更新任务状态",
    "创建和关闭本人公开链接",
  ])
    await page.getByLabel(label).check();
  await page.getByRole("button", { name: "允许所选能力" }).click();
  const outcome = await Promise.race([
    loggedIn,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("OAuth completion timed out")),
        45000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(outcome.success, true, JSON.stringify(outcome));
  const thread = await call("thread/start", {
    cwd: directory,
    ephemeral: true,
  });
  const inventory = await call("mcpServerStatus/list", {
    threadId: thread.thread.id,
  });
  const tools = inventory.data.find(
    (server) => server.name === "daily_test",
  )?.tools;
  assert.ok(
    Object.values(tools ?? {}).some((tool) => tool.name === "get_context"),
    "Codex discovers get_context",
  );
  const result = await call("mcpServer/tool/call", {
    threadId: thread.thread.id,
    server: "daily_test",
    tool: "get_context",
    arguments: {},
  });
  const serialized = JSON.stringify(result);
  assert.ok(
    serialized.includes(identity.member.id),
    "Codex returns authenticated member",
  );
  assert.ok(serialized.includes("Asia/Shanghai"));
  async function invoke(tool, args, expectedError) {
    const response = await call("mcpServer/tool/call", {
      threadId: thread.thread.id,
      server: "daily_test",
      tool,
      arguments: args,
    });
    const payload = response.result ?? response;
    const data =
      payload.structuredContent ??
      JSON.parse(payload.content.find((item) => item.type === "text").text);
    if (expectedError) assert.equal(data.error?.code, expectedError);
    else assert.ok(!payload.isError, JSON.stringify(payload));
    return data;
  }
  const context = await invoke("get_context", {});
  async function web(path, body) {
    const response =
      body === undefined
        ? await page.request.get(`${origin}/api${path}`)
        : await page.request.post(`${origin}/api${path}`, {
            data: body,
            headers: { Origin: origin },
          });
    assert.ok(response.ok(), `${path}: ${response.status()}`);
    return response.json();
  }
  const project = await web("/projects", {
    name: "同名项目",
    description: "成员明确选择的项目",
  });
  await web("/projects", { name: "同名项目", description: "另一个候选" });
  const candidates = await invoke("list_projects", { query: "同名项目" });
  assert.equal(candidates.items.length, 2);
  // The acceptance fixture explicitly selects this ID after inspecting candidates.
  const taskInput = {
    operationId: randomUUID(),
    projectId: project.id,
    name: "Codex 实际任务",
    description: "隔离验收",
  };
  const { task } = await invoke("create_task", taskInput);
  assert.equal((await invoke("create_task", taskInput)).replayed, true);
  const entryId = randomUUID(),
    draftInput = {
      operationId: randomUUID(),
      title: "Codex 实际日报",
      entries: [
        {
          id: entryId,
          body: "完成查询和整理",
          projectId: project.id,
          taskId: task.id,
          statusChange: {
            status: "in-progress",
            expectedVersion: task.version,
          },
        },
      ],
    };
  let { diary } = await invoke("create_draft", draftInput);
  const patch = {
    operationId: randomUUID(),
    id: diary.id,
    expectedVersion: diary.version,
    changes: [{ op: "add", entry: { id: randomUUID(), body: "补充临时工作" } }],
  };
  diary = (await invoke("update_draft", patch)).diary;
  const draft = await web(`/diaries/${diary.id}`);
  await web(`/diaries/${diary.id}/save`, {
    version: draft.version,
    title: draft.draft.title,
    entries: draft.draft.entries,
  });
  await invoke(
    "update_draft",
    { ...patch, operationId: randomUUID(), changes: [] },
    "version-conflict",
  );
  // A fresh explicit instruction uses the web version; no automatic conflict retry.
  const current = await invoke("get_my_draft", { id: diary.id });
  const submission = {
    operationId: randomUUID(),
    id: diary.id,
    expectedVersion: current.version,
  };
  diary = (await invoke("submit_diary", submission)).diary;
  assert.equal((await invoke("submit_diary", submission)).replayed, true);
  assert.equal((await web(`/tasks/${task.id}`)).status, "in-progress");
  assert.equal(
    (await invoke("query_progress", { projectId: project.id })).items.length,
    1,
  );
  const { share } = await invoke("create_share", {
    operationId: randomUUID(),
    type: "diary",
    from: diary.diaryDate,
    to: diary.diaryDate,
    modules: ["overview", "tasks", "progress"],
  });
  const publicResult = await (
    await fetch(`${origin}/api/public/${share.token}`)
  ).json();
  assert.equal(publicResult.progress[0].published.entries.length, 2);
  assert.equal(publicResult.tasks[0].status, "in-progress");
  await invoke("update_task_status", {
    operationId: randomUUID(),
    id: task.id,
    expectedVersion: 2,
    status: "done",
  });
  const latestPublic = await (
    await fetch(`${origin}/api/public/${share.token}`)
  ).json();
  assert.equal(latestPublic.tasks[0].status, "done");
  assert.equal(
    latestPublic.progress[0].published.entries[0].taskStatus,
    "in-progress",
  );
  await page.goto(`${origin}/team`);
  console.log("Business API workflow passed; checking team page.");
  await page
    .getByRole("heading", { name: "Codex 实际日报", exact: true })
    .waitFor();
  const anonymous = await browser.newContext(),
    publicPage = await anonymous.newPage();
  publicPage.setDefaultTimeout(15000);
  await publicPage.goto(share.url);
  await publicPage
    .getByRole("button", { name: "进展日报", exact: true })
    .click();
  await publicPage.getByText("补充临时工作", { exact: true }).waitFor();
  await anonymous.close();
  assert.ok(
    (await web("/ai/operations")).items.some(
      (row) =>
        row.outcome === "failure" && row.errorCode === "version-conflict",
    ),
  );
  if (process.env.CODEX_EXPIRY_WAIT === "1") {
    console.log(
      "Waiting for the real 15-minute credential lifetime; test process remains isolated.",
    );
    await new Promise((resolve) => setTimeout(resolve, 905000));
    const renewed = await call("mcpServer/tool/call", {
      threadId: thread.thread.id,
      server: "daily_test",
      tool: "get_context",
      arguments: {},
    });
    assert.ok(
      JSON.stringify(renewed).includes(identity.member.id),
      "Codex refreshes expired credential",
    );
  }
  await page.goto(`${origin}/ai`);
  await page.getByRole("button", { name: "撤销连接", exact: true }).click();
  await page.getByText("已撤销", { exact: true }).waitFor();
  let denied = false;
  try {
    const result = await call("mcpServer/tool/call", {
      threadId: thread.thread.id,
      server: "daily_test",
      tool: "get_context",
      arguments: {},
    });
    denied = !JSON.stringify(result).includes(identity.member.id);
  } catch {
    denied = true;
  }
  assert.equal(denied, true, "Web revocation rejects subsequent Codex calls");
  console.log(
    JSON.stringify({
      codex: execFileSync(binary, ["--version"], {
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      oauth: "passed",
      browserDefaults: "passed",
      discovery: "passed",
      getContext: "passed",
      workflow:
        "candidates/draft/patch/conflict/submit/task/share/web/public passed",
      refresh: process.env.CODEX_EXPIRY_WAIT === "1" ? "passed" : "not-run",
      revoke: "passed",
      isolated: true,
    }),
  );
} finally {
  await browser?.close();
  if (processHandle && processHandle.exitCode === null) {
    const exited = new Promise((resolve) =>
      processHandle.once("exit", resolve),
    );
    processHandle.kill();
    await exited;
  }
  await app.close();
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
