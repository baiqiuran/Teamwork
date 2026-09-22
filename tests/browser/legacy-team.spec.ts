import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../application.ts";
import { legacy, seedLegacyWork } from "../legacy-team-fixture.ts";

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`旧团队迁移后登录、工作内容和会话失效 ${viewport.width}`, async ({
    page,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "daily-legacy-browser-"));
    const databasePath = join(directory, "legacy.sqlite");
    await seedLegacyWork(databasePath, "http://127.0.0.1:4311");
    const app = await createApp({
      databasePath,
      now: () => legacy.at,
      staticDirectory: join(process.cwd(), "dist"),
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 500)
        errors.push(`${response.status()} ${response.url()}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("401"))
        errors.push(message.text());
    });
    try {
      const server = await app.listen(0);
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No address");
      const origin = `http://127.0.0.1:${address.port}`;
      await page.setViewportSize(viewport);
      await page.goto(`${origin}/login`);
      await page.getByLabel("邮箱", { exact: true }).fill(legacy.member.email);
      await page.getByLabel("密码", { exact: true }).fill(legacy.password);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(page.locator(".team-badge")).toContainText("Ｔｅａｍ 研发");
      await page.getByRole("button", { name: "我的日报", exact: true }).click();
      await page.getByRole("button", { name: /原私人草稿/ }).click();
      await expect(page.getByLabel("工作 1", { exact: true })).toHaveValue(
        "未提交的原内容",
      );
      await page.getByRole("button", { name: "团队日报", exact: true }).click();
      await page.getByLabel("开始日期", { exact: true }).fill("2026-09-16");
      await page.getByLabel("结束日期", { exact: true }).fill("2026-09-16");
      await page.getByRole("button", { name: "查看日报", exact: true }).click();
      await expect(page.locator(".records")).toContainText(
        "迁移前已完成的工作",
      );
      await expect(page.locator(".records")).not.toContainText("原日报待重提");
      await page
        .getByRole("button", { name: "项目与任务", exact: true })
        .click();
      await page.getByRole("button", { name: /原项目/ }).click();
      await page.getByRole("button", { name: /原任务.*已完成/ }).click();
      await expect(page.getByLabel("任务详情")).toContainText("原任务说明");
      await page.getByRole("button", { name: "我的账号", exact: true }).click();
      await expect(page.locator(".account-card")).toContainText(
        legacy.member.email,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.reload();
      await expect(page.locator(".team-badge")).toContainText("Ｔｅａｍ 研发");
      await page.getByRole("button", { name: "退出登录", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "登录", exact: true }),
      ).toBeVisible();
      const response = await page.request.get(`${origin}/api/me`);
      expect(response.status()).toBe(401);
      expect((await response.json()).error).toBe("请先登录。");
      expect(errors).toEqual([]);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
