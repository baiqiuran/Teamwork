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
    setupKey: "isolated-key",
    staticDirectory: join(process.cwd(), "dist"),
  });
  let client: Awaited<ReturnType<typeof mcpClient>> | undefined;
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
        setupKey: "isolated-key",
      },
    });
    expect(setup.status()).toBe(201);
    await page.goto(`${origin}/ai`);
    await page
      .getByRole("button", { name: "通过 Node 连接", exact: true })
      .click();
    const panel = page.getByRole("region", { name: "Node 授权 Key" });
    await expect(panel.getByLabel("查询团队工作进展")).toBeChecked();
    await expect(panel.getByLabel("创建和修改本人草稿")).toBeChecked();
    await expect(panel.getByLabel("自动提交我的日报")).not.toBeChecked();
    await expect(panel.getByLabel("创建任务和更新任务状态")).not.toBeChecked();
    await expect(
      panel.getByLabel("创建和关闭本人的公开链接"),
    ).not.toBeChecked();
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
    const configuration = JSON.parse(
      await panel.getByLabel("MCP 客户端配置", { exact: true }).inputValue(),
    );
    expect(configuration.mcpServers["daily-flow"].env.DAILY_FLOW_API_KEY).toBe(
      key,
    );
    expect(configuration.mcpServers["daily-flow"].env.DAILY_FLOW_URL).toBe(
      `${origin}/mcp`,
    );
    expect(
      (await client.listTools()).tools.some(
        (tool) => tool.name === "create_draft",
      ),
    ).toBe(true);
    await panel.getByRole("button", { name: "我已保存，隐藏 Key" }).click();
    await expect(
      panel.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "我的桌面助手", exact: true }),
    ).toBeVisible();
    expect(await page.locator("body").textContent()).not.toContain(key);
    await page.getByRole("button", { name: "撤销连接", exact: true }).click();
    await expect(page.getByText("已撤销", { exact: true })).toBeVisible();
    await expect(
      page.getByText("需要再次连接时，请生成新的授权 Key。"),
    ).toBeVisible();
    const rejected = await page.request.get(`${origin}/mcp`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(rejected.status()).toBe(401);
  } finally {
    await client?.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
