import { expect, test as base, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../application.ts";
import { mcpClient } from "../mcp-support.ts";

const test = base.extend<{ origin: string }>({
  origin: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "daily-mcp-connections-"));
    const app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      staticDirectory: join(process.cwd(), "dist"),
    });
    try {
      const server = await app.listen(0, "127.0.0.1");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No address");
      await use(`http://127.0.0.1:${address.port}`);
    } finally {
      try {
        await app.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
});

async function createTeam(
  page: Page,
  origin: string,
  name: string,
  email: string,
) {
  const response = await page.request.post(`${origin}/api/setup`, {
    headers: { Origin: origin },
    data: {
      teamName: `${name}团队`,
      name: `${name}成员`,
      email,
      password: "McpScope2026!",
    },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

function observeErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) =>
    errors.push(`${request.failure()?.errorText} ${request.url()}`),
  );
  page.on("response", (response) => {
    if (response.status() < 400) return;
    errors.push(
      `${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`,
    );
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function issueKey(page: Page, origin: string, label: string) {
  await page.goto(`${origin}/ai`);
  await page
    .getByRole("button", { name: "通过 Node 连接", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Node 授权 Key" });
  await expect(panel.getByLabel("查询团队工作进展")).toBeChecked();
  await expect(panel.getByLabel("读写本人日报草稿")).toBeChecked();
  await panel.getByText("更多权限").click();
  for (const scope of [
    "提交本人日报",
    "创建任务和更新任务状态",
    "创建和关闭本人公开链接",
  ])
    await expect(panel.getByLabel(scope)).not.toBeChecked();
  await panel.getByLabel("提交本人日报").check();
  await panel.getByLabel("连接名称", { exact: true }).fill(label);
  await panel
    .getByRole("button", { name: "生成授权 Key", exact: true })
    .click();
  const field = panel.getByRole("textbox", { name: "授权 Key", exact: true });
  await expect(field).toHaveValue(/^dfk_/);
  const key = await field.inputValue();
  await panel.getByRole("button", { name: "复制 Key", exact: true }).click();
  await expect(panel.getByRole("status").first()).toContainText("已复制Key");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
  await panel.getByLabel("服务地址", { exact: true }).waitFor();
  expect(await panel.getByLabel("服务地址", { exact: true }).inputValue()).toBe(
    `${origin}/mcp`,
  );
  const configuration = await panel
    .getByLabel("Codex 配置", { exact: true })
    .inputValue();
  await panel
    .getByRole("button", { name: "复制 Codex 配置", exact: true })
    .click();
  await expect(panel.getByRole("status").first()).toContainText(
    "已复制Codex 配置",
  );
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.replace(/\r\n/g, "\n")).toBe(configuration);
  expect(configuration).toContain("[mcp_servers.daily_flow_node]");
  expect(configuration).toContain('command = "cmd"');
  expect(configuration).toContain("--package=daily-flow-mcp@0.1.0");
  expect(configuration).toContain(`DAILY_FLOW_URL = "${origin}/mcp"`);
  expect(configuration).toContain(`DAILY_FLOW_API_KEY = "${key}"`);
  await expect(panel.getByLabel("本地包路径")).toHaveCount(0);
  return { panel, key };
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`两个团队的成员各自创建、复制和撤销 MCP 连接 ${viewport.width}`, async ({
    page,
    browser,
    origin,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    const otherContext = await browser.newContext({ viewport });
    const other = await otherContext.newPage();
    await other.setViewportSize(viewport);
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await otherContext.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin,
    });
    const errors = [observeErrors(page), observeErrors(other)];
    let ownClient: Awaited<ReturnType<typeof mcpClient>> | undefined;
    let outsideClient: Awaited<ReturnType<typeof mcpClient>> | undefined;
    try {
      const own = await createTeam(
        page,
        origin,
        "青山",
        "mcp-green@example.test",
      );
      const outside = await createTeam(
        other,
        origin,
        "蓝海",
        "mcp-blue@example.test",
      );
      expect(own.team.id).not.toBe(outside.team.id);
      const ownKey = await issueKey(page, origin, "青山桌面助手");
      const outsideKey = await issueKey(other, origin, "蓝海桌面助手");

      ownClient = await mcpClient(origin, ownKey.key);
      expect((await ownClient.listTools()).tools.length).toBeGreaterThan(0);
      await expect(
        page.getByText("查询团队工作进展 · 读写本人日报草稿 · 提交本人日报"),
      ).toBeVisible();
      // 列表是异步读取：先等到自己的 Key 行出现，再对同一份快照做隐私断言。
      await expect(page.locator(".content")).toContainText("Node · 授权 Key");
      const listText = await page.locator(".content").innerText();
      expect(listText).not.toContain(ownKey.key);
      expect(listText).not.toContain("蓝海桌面助手");
      expect(listText).not.toContain("mcp-blue@example.test");

      await other.reload();
      await other.goto(`${origin}/ai`);
      await expect(other.locator(".content")).toContainText("蓝海桌面助手");
      const otherList = await other.locator(".content").innerText();
      expect(otherList).not.toContain("青山桌面助手");
      expect(otherList).not.toContain(ownKey.key);

      await page.reload();
      await expect(
        page.getByRole("heading", { name: "青山桌面助手", exact: true }),
      ).toBeVisible();
      expect(await page.locator("body").innerText()).not.toContain(ownKey.key);
      await page.getByRole("button", { name: "撤销连接", exact: true }).click();
      await expect(page.getByText("已撤销", { exact: true })).toBeVisible();
      await expect(
        page.getByText("需要再次连接时，请生成新的授权 Key。"),
      ).toBeVisible();
      const rejected = await page.request.get(`${origin}/mcp`, {
        headers: { Authorization: `Bearer ${ownKey.key}` },
      });
      expect(rejected.status()).toBe(401);
      expect(await rejected.text()).not.toContain("青山");
      outsideClient = await mcpClient(origin, outsideKey.key);
      expect((await outsideClient.listTools()).tools.length).toBeGreaterThan(0);
      await other.reload();
      await expect(
        other.getByRole("heading", { name: "蓝海桌面助手", exact: true }),
      ).toBeVisible();
      await expect(
        other.getByText("查询团队工作进展 · 读写本人日报草稿"),
      ).toBeVisible();
      for (const current of [page, other]) {
        expect(
          await current.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          `${current.url()} 横向溢出`,
        ).toBe(true);
      }
    } finally {
      await ownClient?.close();
      await outsideClient?.close();
      for (const observed of errors) expect.soft(observed).toEqual([]);
      await otherContext.close();
    }
  });
}
