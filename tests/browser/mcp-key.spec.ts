import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../application.ts";
import { mcpClient } from "../mcp-support.ts";

test("网页创建 Key、默认能力、一次性展示和撤销", async ({ page }) => {
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
    const panel = page.getByRole("region", { name: "Node 授权 Key" });
    await expect(panel.getByLabel("查询团队工作进展")).toBeChecked();
    await expect(panel.getByLabel("查询团队工作进展")).toBeDisabled();
    await expect(panel.getByLabel("读写本人日报草稿")).toBeChecked();
    await expect(panel.getByText("提交本人日报")).not.toBeVisible();
    await panel.getByText("更多权限").click();
    await expect(panel.getByLabel("提交本人日报")).not.toBeChecked();
    await expect(panel.getByLabel("创建任务和更新任务状态")).not.toBeChecked();
    await expect(panel.getByLabel("创建和关闭本人公开链接")).not.toBeChecked();
    await panel.getByLabel("连接名称", { exact: true }).fill("我的桌面助手");
    await panel
      .getByRole("button", { name: "生成授权 Key", exact: true })
      .click();
    await expect(
      panel.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveValue(/^dfk_/);
    const key = await panel
      .getByRole("textbox", { name: "授权 Key", exact: true })
      .inputValue();
    await expect(
      page.getByRole("heading", { name: "我的桌面助手", exact: true }),
    ).toBeVisible();
    await expect(panel.getByLabel("服务地址", { exact: true })).toHaveValue(
      `${origin}/mcp`,
    );
    client = await mcpClient(origin, key);
    const packagePath = panel.getByLabel("本地包路径");
    await expect(packagePath).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "复制 Codex 配置" }),
    ).toBeDisabled();
    await packagePath.fill("C:/tools/daily-flow-mcp-0.1.0.tgz");
    await expect(panel.getByText(/包含明文 Key/)).toBeVisible();
    const configuration = await panel
      .getByLabel("Codex 配置", { exact: true })
      .inputValue();
    expect(configuration).toContain("[mcp_servers.daily_flow_node]");
    expect(configuration).toContain('command = "cmd"');
    expect(configuration).toContain(
      'args = ["/c","npx","--yes","--package=C:/tools/daily-flow-mcp-0.1.0.tgz","daily-flow-mcp"]',
    );
    expect(configuration).toContain(`DAILY_FLOW_URL = "${origin}/mcp"`);
    expect(configuration).toContain(`DAILY_FLOW_API_KEY = "${key}"`);
    expect(
      (await client.listTools()).tools.some(
        (tool) => tool.name === "create_draft",
      ),
    ).toBe(true);
    await expect(panel.getByText(/待测试：完成列出项目后/)).toBeVisible();
    await expect(page.getByText(/待测试：请让 Codex 列出项目/)).toBeVisible();
    const emptyRead = await client.callTool({
      name: "list_projects",
      arguments: { query: "no-such-project-ui-2026" },
    });
    expect(emptyRead.isError).not.toBe(true);
    await panel.getByRole("button", { name: "检查查询结果" }).click();
    await expect(
      panel.getByText("已连接：这个 Key 已完成一次只读查询。"),
    ).toBeVisible();
    await expect(page.getByText(/已连接：只读查询成功于/)).toBeVisible();
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
    const replacementKey = await replacement
      .getByRole("textbox", { name: "授权 Key", exact: true })
      .inputValue();
    await expect(
      replacement.getByText(/替换原 daily_flow_node 配置/),
    ).toBeVisible();
    expect(replacementKey).toMatch(/^dfk_/);
    expect(replacementKey).not.toBe(key);
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
    await replacement.getByRole("button", { name: "撤销旧 Key" }).click();
    await expect(page.getByText("已撤销", { exact: true })).toBeVisible();
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
  } finally {
    await client?.close();
    await replacementClient?.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
