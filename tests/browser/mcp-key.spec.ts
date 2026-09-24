import { test, expect } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createUnconfiguredApp } from "../application.ts";
import { mcpClient } from "../mcp-support.ts";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("同址独立配置可键盘返回，创建后三个区域直接可用且重新打开默认隐藏", async ({
  page,
}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), "daily-focused-key-ui-"));
  const app = await createApp({
    databasePath: join(directory, "test.sqlite"),
    staticDirectory: join(process.cwd(), "dist"),
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const server = await app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const origin = `http://127.0.0.1:${address.port}`;
    expect(
      (
        await page.request.post(`${origin}/api/setup`, {
          headers: { Origin: origin },
          data: {
            name: "配置成员",
            email: "focused@example.test",
            password: "BrowserFixture2026!",
            teamName: "配置团队",
          },
        })
      ).status(),
    ).toBe(201);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/ai`);
    const add = page.getByRole("button", {
      name: "通过 Node 连接",
      exact: true,
    });
    await add.focus();
    await add.press("Enter");
    await expect(page).toHaveURL(`${origin}/ai`);
    await expect(page.getByRole("region", { name: "已有连接" })).toHaveCount(0);
    const focused = page.getByRole("region", { name: "连接配置", exact: true });
    const back = focused.getByRole("button", {
      name: "返回连接管理",
      exact: true,
    });
    await expect(back).toBeFocused();
    await expect(focused.getByLabel("服务地址", { exact: true })).toHaveCount(
      0,
    );
    await focused.getByLabel("连接名称", { exact: true }).fill("专注配置助手");
    await focused
      .getByRole("button", { name: "生成授权 Key", exact: true })
      .click();
    await expect(
      focused.getByRole("heading", { name: "保存密钥", exact: true }),
    ).toBeFocused();
    for (const name of ["保存密钥", "客户端配置", "连接检查"]) {
      await expect(
        focused.getByRole("region", { name, exact: true }),
      ).toBeVisible();
    }
    await expect(
      focused.getByRole("heading", { name: "专注配置助手", exact: true }),
    ).toBeVisible();
    await expect(
      focused.getByText("查询团队工作进展 · 读写本人日报草稿", { exact: true }),
    ).toBeVisible();
    await expect(
      focused.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveCount(0);
    await expect(focused.getByText(/直到撤销/)).toBeVisible();
    await focused
      .getByLabel("本地包路径")
      .fill("C:/tools/daily-flow-mcp-0.1.0.tgz");
    await focused
      .getByLabel("密钥文件路径", { exact: true })
      .fill("C:/Users/member/.daily-flow/member.key");
    await expect(
      focused.getByRole("button", { name: "复制 Codex 配置", exact: true }),
    ).toBeEnabled();
    await expect(
      focused.getByRole("button", { name: "检查查询结果", exact: true }),
    ).toBeEnabled();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("focused-key-golden-1440.png"),
      fullPage: true,
    });
    await focused
      .getByRole("button", { name: "显示 Key", exact: true })
      .click();
    const field = focused.getByRole("textbox", {
      name: "授权 Key",
      exact: true,
    });
    await expect(field).toHaveValue(/^dfk_/);
    const key = await field.inputValue();
    await back.focus();
    await back.press("Enter");
    await expect(add).toBeFocused();
    expect(await page.content()).not.toContain(key);
    await expect(page.getByRole("region", { name: "已有连接" })).toBeVisible();
    await page
      .getByRole("article")
      .filter({
        has: page.getByRole("heading", { name: "专注配置助手", exact: true }),
      })
      .getByRole("button", { name: "查看 Key / 配置", exact: true })
      .click();
    await expect(field).toHaveCount(0);
    await expect(page).toHaveURL(`${origin}/ai`);
    for (const width of [720, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await expect(
        focused.getByRole("button", { name: "显示 Key", exact: true }),
      ).toBeEnabled();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: testInfo.outputPath(`focused-key-${width}.png`),
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("配置复制失败可手动处理，检查加载与网络失败可重试，真实 Key 服务不可用不泄密", async ({
  page,
}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), "daily-focused-errors-"));
  const options = {
    databasePath: join(directory, "test.sqlite"),
    staticDirectory: join(process.cwd(), "dist"),
  };
  let app = await createApp(options);
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  try {
    const server = await app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const origin = `http://127.0.0.1:${address.port}`;
    expect(
      (
        await page.request.post(`${origin}/api/setup`, {
          headers: { Origin: origin },
          data: {
            name: "错误检查",
            email: "focused-errors@example.test",
            password: "BrowserFixture2026!",
            teamName: "错误检查团队",
          },
        })
      ).status(),
    ).toBe(201);
    const issued = await (
      await page.request.post(`${origin}/api/ai/keys`, {
        headers: { Origin: origin },
        data: { name: "错误检查助手", scopes: ["progress:read"] },
      })
    ).json();
    await page.goto(`${origin}/ai`);
    await page
      .getByRole("button", { name: "查看 Key / 配置", exact: true })
      .click();
    const focused = page.getByRole("region", { name: "连接配置", exact: true });
    const configuration = focused.getByRole("region", {
      name: "客户端配置",
      exact: true,
    });
    const check = focused.getByRole("region", {
      name: "连接检查",
      exact: true,
    });
    await configuration
      .getByLabel("本地包路径")
      .fill("C:/tools/daily-flow-mcp-0.1.0.tgz");
    await configuration
      .getByLabel("密钥文件路径", { exact: true })
      .fill("C:/Users/member/.daily-flow/member.key");
    // Reject only the browser clipboard boundary, not application collaborators.
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new DOMException("denied", "NotAllowedError");
      };
    });
    await configuration
      .getByRole("button", { name: "复制 Codex 配置", exact: true })
      .click();
    await expect(configuration.getByRole("alert")).toContainText(
      "请选中Codex 配置手动复制",
    );
    const text = configuration.getByRole("textbox", {
      name: "Codex 配置",
      exact: true,
    });
    await text.focus();
    await text.press("ControlOrMeta+A");
    expect(
      await text.evaluate((element: HTMLTextAreaElement) =>
        element.value.slice(element.selectionStart, element.selectionEnd),
      ),
    ).toContain("DAILY_FLOW_API_KEY_FILE");
    await expect(
      focused.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveCount(0);
    expect(await page.content()).not.toContain(issued.key);
    await page.setViewportSize({ width: 720, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("focused-clipboard-error-720.png"),
      fullPage: true,
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/ai/connections", async (route) => {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    const checkButton = check.getByRole("button", {
      name: "检查查询结果",
      exact: true,
    });
    await checkButton.click();
    try {
      await expect(
        check.getByRole("button", { name: "正在检查…", exact: true }),
      ).toBeDisabled();
      await expect(check.getByRole("status")).toContainText("正在检查");
    } finally {
      release();
    }
    await expect(checkButton).toBeEnabled();
    await expect(check.getByRole("status")).toContainText("尚未检测到成功查询");
    await page.unroute("**/api/ai/connections");
    await page.route("**/api/ai/connections", (route) => route.abort("failed"));
    await checkButton.click();
    await expect(check.getByRole("alert")).toContainText("检查失败");
    await expect(check.getByRole("alert")).toContainText("重试");
    await expect(checkButton).toBeEnabled();
    await expect(check.getByText(/已连接：/)).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("focused-check-error-720.png"),
      fullPage: true,
    });
    await page.unroute("**/api/ai/connections");
    await checkButton.click();
    await expect(check.getByRole("alert")).toHaveCount(0);
    await expect(check.getByRole("status")).toContainText("尚未检测到成功查询");

    // Restart the real HTTP application on the same isolated SQLite without a master.
    await app.close();
    app = await createUnconfiguredApp(options);
    await app.listen(address.port);
    const unavailable = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/connections/${issued.id}/key`) &&
        response.status() === 503,
    );
    await focused
      .getByRole("button", { name: "显示 Key", exact: true })
      .click();
    await unavailable;
    await expect(
      focused.getByRole("alert").filter({ hasText: "成员 Key 服务暂不可用" }),
    ).toBeVisible();
    await expect(
      focused.getByRole("button", { name: "显示 Key", exact: true }),
    ).toBeEnabled();
    expect(await page.content()).not.toContain(issued.key);
    await page.setViewportSize({ width: 390, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("focused-service-unavailable-390.png"),
      fullPage: true,
    });
    expect(
      (await (await page.request.get(`${origin}/api/ai/connections`)).json())[0]
        .revokedAt,
    ).toBeNull();
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([
      expect.stringMatching(/net::ERR_FAILED/),
      expect.stringMatching(/503 \(Service Unavailable\)/),
    ]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("缺少服务器主密钥时说明 Key 服务不可用而非声称已生成", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "daily-key-unconfigured-ui-"));
  const app = await createUnconfiguredApp({
    databasePath: join(directory, "test.sqlite"),
    staticDirectory: join(process.cwd(), "dist"),
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const server = await app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const origin = `http://127.0.0.1:${address.port}`;
    await page.request.post(`${origin}/api/setup`, {
      headers: { Origin: origin },
      data: {
        name: "未配置",
        email: "unconfigured@example.test",
        password: "BrowserFixture2026!",
        teamName: "未配置团队",
      },
    });
    await page.goto(`${origin}/ai`);
    await page
      .getByRole("button", { name: "通过 Node 连接", exact: true })
      .click();
    await page
      .getByRole("button", { name: "生成授权 Key", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("主密钥");
    await expect(
      page.getByRole("button", { name: "生成授权 Key", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveCount(0);
    expect(
      await (await page.request.get(`${origin}/api/ai/connections`)).json(),
    ).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("网页创建 Key 默认隐藏、配置仅引用文件并可撤销", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const directory = await mkdtemp(join(tmpdir(), "daily-key-ui-"));
  const app = await createApp({
    databasePath: join(directory, "test.sqlite"),
    staticDirectory: join(process.cwd(), "dist"),
  });
  let client: Awaited<ReturnType<typeof mcpClient>> | undefined;
  let replacementClient: Awaited<ReturnType<typeof mcpClient>> | undefined;
  try {
    const server = await app.listen(0),
      address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const origin = `http://127.0.0.1:${address.port}`;
    const setup = await page.request.post(`${origin}/api/setup`, {
      headers: { Origin: origin },
      data: {
        name: "Key 成员",
        email: "key-ui@example.test",
        password: "BrowserFixture2026!",
        teamName: "隔离团队",
      },
    });
    expect(setup.status()).toBe(201);
    await page.goto(`${origin}/ai`);
    await page
      .getByRole("button", { name: "通过 Node 连接", exact: true })
      .click();
    let panel = page.getByRole("region", {
      name: "Node 授权 Key",
      exact: true,
    });
    const reopen = async () => {
      await page
        .getByRole("article")
        .filter({
          has: page.getByRole("heading", { name: "我的桌面助手", exact: true }),
        })
        .getByRole("button", { name: "查看 Key / 配置", exact: true })
        .click();
      panel = page.getByRole("region", {
        name: "查看 Node 授权 Key",
        exact: true,
      });
    };
    await expect(panel.getByLabel("查询团队工作进展")).toBeChecked();
    await expect(panel.getByLabel("查询团队工作进展")).toBeDisabled();
    await expect(panel.getByLabel("读写本人日报草稿")).toBeChecked();
    await expect(panel.getByText("提交本人日报")).not.toBeVisible();
    await panel.getByText("更多权限").click();
    for (const consequence of [
      "正式提交本人日报，并更新关联项目的公开进展。",
      "创建任务或更新状态，可能改变公开任务列表。",
      "创建或关闭本人公开链接，让持链接者查看所选范围。",
    ])
      await expect(panel.getByText(consequence, { exact: true })).toBeVisible();
    await expect(panel.getByLabel("提交本人日报")).not.toBeChecked();
    await expect(panel.getByLabel("创建任务和更新任务状态")).not.toBeChecked();
    await expect(panel.getByLabel("创建和关闭本人公开链接")).not.toBeChecked();
    await panel.getByLabel("连接名称", { exact: true }).fill("我的桌面助手");
    await panel
      .getByRole("button", { name: "生成授权 Key", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: "显示 Key", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new DOMException("Clipboard access denied", "NotAllowedError");
      };
    });
    await panel.getByRole("button", { name: "复制 Key", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText(
      "无法自动复制，请点击“显示 Key”后手动复制。",
    );
    await expect(
      panel.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveCount(0);
    await panel.getByRole("button", { name: "显示 Key", exact: true }).click();
    await expect(
      panel.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveValue(/^dfk_/);
    const key = await panel
      .getByRole("textbox", { name: "授权 Key", exact: true })
      .inputValue();
    await panel
      .getByRole("button", { name: "隐藏 Key 正文", exact: true })
      .click();
    await expect(
      panel.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveCount(0);
    expect(await page.content()).not.toContain(key);
    await page.getByRole("tab", { name: "操作记录", exact: true }).click();
    await expect(panel).not.toBeVisible();
    await page.getByRole("tab", { name: "连接管理", exact: true }).click();
    await reopen();
    await panel.getByRole("button", { name: "显示 Key", exact: true }).click();
    await expect(
      panel.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveValue(key);
    await panel
      .getByRole("button", { name: "隐藏 Key 正文", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "我的桌面助手", exact: true }),
    ).toBeVisible();
    await expect(panel.getByLabel("服务地址", { exact: true })).toHaveValue(
      `${origin}/mcp`,
    );
    const memberFile = join(directory, "temporary-member.key");
    await writeFile(memberFile, `${key}\n`, { mode: 0o600 });
    client = new Client({ name: "browser-key-node-query", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "packages/mcp-node/bin/daily-flow-mcp.mjs")],
      env: { DAILY_FLOW_URL: origin, DAILY_FLOW_API_KEY_FILE: memberFile },
      stderr: "pipe",
    });
    let nodeErrors = "";
    transport.stderr?.on("data", (chunk) => {
      nodeErrors += String(chunk);
    });
    await client.connect(transport);
    expect(nodeErrors).not.toContain(key);
    const packagePath = panel.getByLabel("本地包路径");
    await expect(packagePath).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "复制 Codex 配置" }),
    ).toBeDisabled();
    await packagePath.fill("C:/tools/daily-flow-mcp-0.1.0.tgz");
    await expect(panel.getByText(/不包含密钥正文/)).toBeVisible();
    const filePath = panel.getByLabel("密钥文件路径", { exact: true });
    const copyConfiguration = panel.getByRole("button", {
      name: "复制 Codex 配置",
    });
    await expect(copyConfiguration).toBeDisabled();
    await expect(panel.getByLabel("Codex 配置", { exact: true })).toHaveValue(
      "请先填写密钥文件的绝对路径。",
    );
    for (const invalidPath of [
      "./member.key",
      "~/member.key",
      "%USERPROFILE%/member.key",
      key,
    ]) {
      await filePath.fill(invalidPath);
      await expect(filePath).toHaveAttribute("aria-invalid", "true");
      await expect(copyConfiguration).toBeDisabled();
      expect(
        await panel.getByLabel("Codex 配置", { exact: true }).inputValue(),
      ).not.toContain(key);
    }
    await filePath.fill("C:\\Users\\本地 成员\\.daily-flow\\member.key");
    await expect(filePath).toHaveAttribute("aria-invalid", "false");
    await expect(copyConfiguration).toBeEnabled();
    const configuration = await panel
      .getByLabel("Codex 配置", { exact: true })
      .inputValue();
    expect(configuration).toContain("[mcp_servers.daily_flow_node]");
    expect(configuration).toContain('command = "cmd"');
    expect(configuration).toContain(
      'args = ["/c","npx","--yes","--package=C:/tools/daily-flow-mcp-0.1.0.tgz","daily-flow-mcp"]',
    );
    expect(configuration).toContain(`DAILY_FLOW_URL = "${origin}/mcp"`);
    expect(configuration).toContain(
      'DAILY_FLOW_API_KEY_FILE = "C:/Users/本地 成员/.daily-flow/member.key"',
    );
    expect(configuration).not.toContain("DAILY_FLOW_API_KEY =");
    expect(configuration).not.toContain(key);
    expect(await page.content()).not.toContain(key);
    expect(
      (await client.listTools()).tools.some(
        (tool) => tool.name === "create_draft",
      ),
    ).toBe(true);
    await expect(panel.getByText(/待测试：完成列出项目后/)).toBeVisible();
    await expect(page.getByText("待测试", { exact: true })).toBeVisible();
    await panel
      .getByRole("button", { name: "检查查询结果", exact: true })
      .click();
    await expect(panel.getByText(/待测试：完成列出项目后/)).toBeVisible();
    await panel
      .getByRole("button", { name: "返回连接管理", exact: true })
      .click();
    await expect(
      page.getByText("请让 Codex 列出项目，再刷新连接。", { exact: true }),
    ).toBeVisible();
    await reopen();
    const emptyRead = await client.callTool({
      name: "list_projects",
      arguments: { query: "no-such-project-ui-2026" },
    });
    expect(emptyRead.isError).not.toBe(true);
    expect(emptyRead.structuredContent).toMatchObject({ items: [] });
    expect(nodeErrors).not.toContain(key);
    await panel.getByRole("button", { name: "检查查询结果" }).click();
    await expect(
      panel.getByText("已连接：这个 Key 已完成一次只读查询。"),
    ).toBeVisible();
    await expect(page.getByText("已连接", { exact: true })).toBeVisible();
    await expect(page.getByText(/最近成功查询：/)).not.toContainText("暂无");
    await panel.getByRole("button", { name: "我已保存，隐藏 Key" }).click();
    await expect(
      panel.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "我的桌面助手", exact: true }),
    ).toBeVisible();
    expect(await page.locator("body").textContent()).not.toContain(key);
    await page
      .getByRole("button", { name: "查看 Key / 配置", exact: true })
      .click();
    const reopened = page.getByRole("region", { name: "查看 Node 授权 Key" });
    await expect(
      reopened.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveCount(0);
    await reopened
      .getByRole("button", { name: "显示 Key", exact: true })
      .click();
    await expect(
      reopened.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveValue(key);
    await page.getByRole("tab", { name: "操作记录", exact: true }).click();
    expect(await page.content()).not.toContain(key);
    await page.getByRole("tab", { name: "连接管理", exact: true }).click();
    await reopen();
    await expect(
      reopened.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("recoverable-key-hidden.png"),
      fullPage: true,
    });
    await reopened
      .getByRole("button", { name: "返回连接管理", exact: true })
      .click();
    await expect(reopened).toHaveCount(0);
    await page
      .getByRole("button", { name: "更换 Key / 调整能力", exact: true })
      .click();
    const replacement = page.getByRole("region", {
      name: "更换 Node 授权 Key",
    });
    await expect(replacement.getByText(/旧连接：我的桌面助手/)).toBeVisible();
    await expect(replacement.getByLabel("查询团队工作进展")).toBeChecked();
    await expect(replacement.getByLabel("读写本人日报草稿")).toBeChecked();
    await replacement.getByLabel("读写本人日报草稿").uncheck();
    await replacement.getByText("更多权限").click();
    await replacement.getByLabel("创建任务和更新任务状态").check();
    await replacement.getByRole("button", { name: "生成授权 Key" }).click();
    await expect(
      replacement.getByRole("button", { name: "显示 Key", exact: true }),
    ).toBeVisible();
    await expect(
      replacement.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveCount(0);
    await replacement
      .getByRole("button", { name: "显示 Key", exact: true })
      .click();
    const replacementKey = await replacement
      .getByRole("textbox", { name: "授权 Key", exact: true })
      .inputValue();
    await expect(
      replacement.getByText(/替换原 daily_flow_node 配置/),
    ).toBeVisible();
    expect(replacementKey).toMatch(/^dfk_/);
    expect(replacementKey).not.toBe(key);
    await replacement
      .getByRole("button", { name: "隐藏 Key 正文", exact: true })
      .click();
    expect(await page.content()).not.toContain(replacementKey);
    // 显示或复制新正文、复制客户端配置都不算连接验证，旧连接此刻不能被撤销。
    await expect(
      replacement.getByRole("button", { name: "撤销旧 Key", exact: true }),
    ).toHaveCount(0);
    const oldTools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(oldTools).toContain("create_draft");
    expect(oldTools).not.toContain("create_task");
    expect(
      (await client.callTool({ name: "list_projects", arguments: {} })).isError,
    ).not.toBe(true);
    replacementClient = await mcpClient(origin, replacementKey);
    const replacementTools = (await replacementClient.listTools()).tools.map(
      (tool) => tool.name,
    );
    expect(replacementTools).toContain("create_task");
    expect(replacementTools).not.toContain("create_draft");
    const failedReplacementRead = await replacementClient.callTool({
      name: "get_project",
      arguments: { id: "b363797c-6e15-4ef4-adbc-13d37009d356" },
    });
    expect(failedReplacementRead.isError).toBe(true);
    await replacement.getByRole("button", { name: "检查查询结果" }).click();
    await expect(replacement.getByText(/待测试：完成列出项目后/)).toBeVisible();
    await expect(
      replacement.getByRole("button", { name: "撤销旧 Key", exact: true }),
    ).toHaveCount(0);
    expect(
      (await client.callTool({ name: "list_projects", arguments: {} })).isError,
    ).not.toBe(true);
    expect(
      (
        await replacementClient.callTool({
          name: "list_projects",
          arguments: {},
        })
      ).isError,
    ).not.toBe(true);
    await replacement.getByRole("button", { name: "检查查询结果" }).click();
    await expect(replacement.getByText(/已连接：这个 Key/)).toBeVisible();
    await expect(
      replacement.getByRole("button", { name: "撤销旧 Key", exact: true }),
    ).toBeVisible();
    await replacement.getByRole("button", { name: "撤销旧 Key" }).click();
    await expect(
      replacement.getByText("旧 Key 已撤销，新 Key 可继续使用。", {
        exact: true,
      }),
    ).toBeVisible();
    await replacement
      .getByRole("button", { name: "返回连接管理", exact: true })
      .click();
    await expect(page.getByText("已撤销", { exact: true })).toBeVisible();
    const oldConnection = page.getByRole("article").filter({
      has: page.getByRole("heading", {
        name: "我的桌面助手",
        exact: true,
      }),
    });
    await expect(
      oldConnection.getByRole("button", {
        name: "查看 Key / 配置",
        exact: true,
      }),
    ).toHaveCount(0);
    const listed = await (
      await page.request.get(`${origin}/api/ai/connections`, {
        headers: { Origin: origin },
      })
    ).json();
    const revokedOld = listed.find(
      (item: { name: string | null }) => item.name === "我的桌面助手",
    );
    expect(revokedOld.canRevealKey).toBe(false);
    expect(
      (
        await page.request.post(
          `${origin}/api/ai/connections/${revokedOld.id}/key`,
          { headers: { Origin: origin }, data: {} },
        )
      ).status(),
    ).toBe(404);
    page.once("dialog", (dialog) => void dialog.accept());
    await oldConnection.getByRole("button", { name: "删除记录" }).click();
    await expect(oldConnection).toHaveCount(0);
    const rejected = await page.request.get(`${origin}/mcp`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(rejected.status()).toBe(401);
    expect(
      (
        await replacementClient.callTool({
          name: "list_projects",
          arguments: {},
        })
      ).isError,
    ).not.toBe(true);
    const legacyResponse = await page.request.post(`${origin}/api/ai/keys`, {
      headers: { Origin: origin },
      data: { name: "旧摘要连接", scopes: ["progress:read"] },
    });
    expect(legacyResponse.status()).toBe(201);
    const legacyKey = await legacyResponse.json();
    const db = new DatabaseSync(join(directory, "test.sqlite"));
    try {
      db.prepare(
        "UPDATE ai_api_keys SET encrypted_key=NULL WHERE grant_id=?",
      ).run(legacyKey.id);
    } finally {
      db.close();
    }
    await page.reload();
    const legacyRow = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "旧摘要连接", exact: true }),
    });
    await expect(legacyRow.getByText(/旧版 Key 没有可恢复正文/)).toBeVisible();
    await expect(
      legacyRow.getByRole("button", { name: "查看 Key / 配置", exact: true }),
    ).toHaveCount(0);
    await expect(
      legacyRow.getByRole("button", {
        name: "更换 Key / 调整能力",
        exact: true,
      }),
    ).toBeEnabled();
  } finally {
    await client?.close();
    await replacementClient?.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
    expect(consoleErrors).toEqual([]);
  }
});
