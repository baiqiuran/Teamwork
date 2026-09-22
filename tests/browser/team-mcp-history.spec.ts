import { expect, test as base, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../application.ts";
import { mcpClient } from "../mcp-support.ts";

const test = base.extend<{ origin: string }>({
  origin: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "daily-mcp-history-"));
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

async function seed<T = any>(
  page: Page,
  origin: string,
  path: string,
  data: object,
  status = 201,
): Promise<T> {
  const response = await page.request.post(`${origin}/api${path}`, {
    headers: { Origin: origin },
    data,
  });
  expect(response.status(), `${path}: ${await response.text()}`).toBe(status);
  return response.json();
}

function observeErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) =>
    errors.push(`${request.failure()?.errorText} ${request.url()}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      errors.push(
        `${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`,
      );
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`本人 MCP 操作记录区分成功、失败与重试，且不出现其他团队内容 ${viewport.width}`, async ({
    page,
    browser,
    origin,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    const own = await seed(page, origin, "/setup", {
      teamName: "青山团队",
      name: "林晓",
      email: "history-green@example.test",
      password: "McpHistory2026!",
    });
    const otherContext = await browser.newContext({ viewport });
    const other = await otherContext.newPage();
    await other.setViewportSize(viewport);
    const outside = await seed(other, origin, "/setup", {
      teamName: "蓝海团队",
      name: "蓝海成员",
      email: "history-blue@example.test",
      password: "McpHistory2026!",
    });
    const colleagueContext = await browser.newContext({ viewport });
    const colleague = await colleagueContext.newPage();
    await colleague.setViewportSize(viewport);
    await seed(colleague, origin, "/join", {
      token: (await seed(page, origin, "/invitations", {})).token,
      name: "周宁",
      email: "history-reader@example.test",
      password: "McpHistory2026!",
    });
    const errors = [
      observeErrors(page),
      observeErrors(other),
      observeErrors(colleague),
    ];
    const outsideProject = (
      await seed(other, origin, "/projects", {
        name: "蓝海私密项目",
        description: "蓝海私密说明",
      })
    ).id as string;
    const ownProject = (
      await seed(page, origin, "/projects", {
        name: "青山可见项目",
        description: "青山可见说明",
      })
    ).id as string;
    let client: Awaited<ReturnType<typeof mcpClient>> | undefined;
    try {
      const issued = await seed(
        page,
        origin,
        "/ai/keys",
        { name: "记录测试 Key", scopes: ["progress:read", "tasks:write"] },
        201,
      );
      client = await mcpClient(origin, issued.key);
      const operationId = randomUUID();
      const created = await client.callTool({
        name: "create_task",
        arguments: {
          operationId,
          projectId: ownProject,
          name: "青山记录任务",
          description: "记录内可见",
        },
      });
      expect(created.isError, JSON.stringify(created)).toBeUndefined();
      const failed = await client.callTool({
        name: "create_task",
        arguments: {
          operationId: randomUUID(),
          projectId: outsideProject,
          name: "越权任务",
          description: "不应创建",
        },
      });
      expect(failed.isError).toBe(true);
      const replay = await client.callTool({
        name: "create_task",
        arguments: {
          operationId,
          projectId: ownProject,
          name: "青山记录任务",
          description: "记录内可见",
        },
      });
      expect(
        JSON.parse(JSON.stringify(replay.structuredContent)).replayed,
      ).toBe(true);

      await page.goto(`${origin}/ai`);
      const records = page.getByRole("region", { name: "AI 操作记录" });
      await expect(
        page.getByRole("heading", { name: "我的 AI 操作记录", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "记录当时的执行结果；对象状态显示当前情况。使用同一操作标识重试时只会返回原结果，不会再次修改业务数据。",
          { exact: true },
        ),
      ).toBeVisible();
      const rows = page.locator('section[aria-label="AI 操作记录"] article');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText("创建任务 · 已处理，返回原结果");
      await expect(rows.nth(1)).toContainText("创建任务 · 失败");
      await expect(rows.nth(1)).toContainText("错误码：not-found");
      await expect(rows.nth(1)).toContainText("未产生可跳转对象");
      await expect(rows.nth(2)).toContainText("创建任务 · 成功");
      await expect(rows.nth(2)).toContainText("当前任务");
      const text = await page
        .locator('section[aria-label="AI 操作记录"]')
        .innerText();
      for (const secret of [
        "蓝海私密项目",
        "蓝海私密说明",
        "蓝海成员",
        outside.member.id,
        "history-blue@example.test",
        "越权任务",
      ])
        expect(text).not.toContain(secret);
      await page.getByRole("link", { name: "查看对象" }).first().click();
      await expect(
        page.getByRole("heading", { name: "青山记录任务" }),
      ).toBeVisible();
      await expect(
        page.getByRole("region", { name: "任务详情" }),
      ).toContainText("记录内可见");

      await page.goto(`${origin}/ai`);
      await page.getByLabel("执行结果").selectOption("failure");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("失败");
      await page.getByLabel("执行结果").selectOption("");
      await expect(rows).toHaveCount(3);

      await colleague.goto(`${origin}/ai`);
      await expect(
        colleague.getByText("暂无操作记录。", { exact: true }),
      ).toBeVisible();
      await other.goto(`${origin}/ai`);
      await expect(
        other.getByText("暂无操作记录。", { exact: true }),
      ).toBeVisible();
      void records;
      void own;
      for (const current of [page, other, colleague]) {
        expect(
          await current.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          `${current.url()} 横向溢出`,
        ).toBe(true);
      }
    } finally {
      await client?.close();
      for (const observed of errors) expect.soft(observed).toEqual([]);
      await otherContext.close();
      await colleagueContext.close();
    }
  });
}
