import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import express from "express";
import { randomUUID } from "node:crypto";
import { createApp } from "../../server/app.ts";

test("页面在北京时间跨日后显示私有未重提内容并禁用修改，团队仍读原文", async ({
  browser,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "daily-window-ui-"));
  let time = Date.parse("2026-09-16T15:59:00Z");
  const service = createApp({
    databasePath: join(directory, "test.sqlite"),
    setupKey: "clock-ui-key",
    now: () => time,
  });
  service.app.use(express.static(resolve("dist")));
  service.app.get("/{*path}", (_req, res) =>
    res.sendFile(resolve("dist/index.html")),
  );
  const server = service.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const origin = `http://127.0.0.1:${address.port}`,
    context = await browser.newContext(),
    page = await context.newPage();
  try {
    await context.request.post(`${origin}/api/setup`, {
      headers: { Origin: origin },
      data: {
        name: "午夜作者",
        email: "midnight@example.test",
        password: "QuietRiver2026!",
        teamName: "午夜团队",
        setupKey: "clock-ui-key",
      },
    });
    const d = await (
      await context.request.post(`${origin}/api/diaries`, {
        headers: { Origin: origin },
        data: {
          title: "午夜记录",
          entries: [{ id: randomUUID(), body: "团队原文" }],
        },
      })
    ).json();
    const pub = await (
      await context.request.post(`${origin}/api/diaries/${d.id}/submit`, {
        headers: { Origin: origin },
        data: { version: 1, requestId: randomUUID() },
      })
    ).json();
    await context.request.post(`${origin}/api/diaries/${d.id}/save`, {
      headers: { Origin: origin },
      data: {
        version: pub.version,
        title: "午夜记录",
        entries: [{ id: randomUUID(), body: "尚未重提的私有修改" }],
      },
    });
    await page.goto(`${origin}/diaries`);
    await page.getByRole("button", { name: /午夜记录/ }).click();
    await expect(page.getByRole("button", { name: "重新提交" })).toBeEnabled();
    time = Date.parse("2026-09-16T16:00:00Z");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("button", { name: "重新提交" })).toBeDisabled();
    await expect(page.getByLabel("工作 1", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("工作 1", { exact: true })).toHaveValue(
      "尚未重提的私有修改",
    );
    await page.getByText("查看团队正在阅读的提交版本", { exact: true }).click();
    await expect(page.getByText("团队原文", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "＋ 新建日报", exact: true })
      .click();
    await expect(page.getByLabel("工作 1", { exact: true })).toBeEnabled();
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
