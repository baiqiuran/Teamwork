import { expect, test as base, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../application.ts";

const at = Date.parse("2026-09-16T02:00:00Z");
const day = "2026-09-16";
const fileBytes = "青山公开附件\n权限验证 2026\n";

const test = base.extend<{ origin: string }>({
  origin: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "daily-team-sharing-"));
    const app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      staticDirectory: join(process.cwd(), "dist"),
      now: () => at,
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

async function createTeam(
  page: Page,
  origin: string,
  name: string,
  email: string,
) {
  return seed<{
    member: { id: string; name: string; teamId: number };
    team: { id: number; name: string };
  }>(page, origin, "/setup", {
    teamName: `${name}团队`,
    name: `${name}成员`,
    email,
    password: "TeamSharing2026!",
  });
}

async function publish(
  page: Page,
  origin: string,
  prefix: string,
  file: string,
) {
  const project = await seed(page, origin, "/projects", {
    name: `${prefix}项目`,
    description: `${prefix}项目说明`,
  });
  const task = await seed(page, origin, `/projects/${project.id}/tasks`, {
    name: `${prefix}任务`,
    description: `${prefix}任务说明`,
  });
  const entry = {
    id: randomUUID(),
    body: `${prefix}已提交工作`,
    projectId: project.id,
    taskId: task.id,
  };
  const draft = await seed(page, origin, "/diaries", {
    title: `${prefix}日报`,
    entries: [entry],
  });
  const uploaded = await seed(
    page,
    origin,
    `/diaries/${draft.id}/entries/${entry.id}/attachments`,
    {
      version: draft.version,
      requestId: randomUUID(),
      name: `${prefix}附件.txt`,
      base64: Buffer.from(file).toString("base64"),
    },
  );
  const diary = await seed(
    page,
    origin,
    `/diaries/${draft.id}/submit`,
    { version: uploaded.version, requestId: randomUUID() },
    200,
  );
  return {
    project,
    task,
    diary,
    file: uploaded.draft.entries[0].attachments[0] as {
      id: string;
      name: string;
    },
  };
}

function observeErrors(page: Page, allowed: string[]) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) =>
    errors.push(`${request.failure()?.errorText} ${request.url()}`),
  );
  page.on("response", (response) => {
    const key = `${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`;
    if (response.status() >= 400 && !allowed.includes(key)) errors.push(key);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const status = message
      .text()
      .match(
        /^Failed to load resource: the server responded with a status of (\d{3})\b/,
      )?.[1];
    const path = new URL(message.location().url || page.url()).pathname;
    if (!status || !allowed.includes(`GET ${path} ${status}`))
      errors.push(message.text());
  });
  return errors;
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    `horizontal overflow at ${page.url()}`,
  ).toBe(true);
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`公开链接的范围授权、跨团队阅读与关闭后失效在浏览器中保持隔离 ${viewport.width}`, async ({
    page,
    browser,
    origin,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const own = await createTeam(page, origin, "青山", "green@example.test");
    const ownWork = await publish(page, origin, "青山", fileBytes);
    const otherContext = await browser.newContext({ viewport });
    const other = await otherContext.newPage();
    const visitorContext = await browser.newContext({ viewport });
    const visitor = await visitorContext.newPage();
    const readerContext = await browser.newContext({ viewport });
    const reader = await readerContext.newPage();
    const outsider = await createTeam(
      other,
      origin,
      "蓝海",
      "blue@example.test",
    );
    const outsideWork = await publish(
      other,
      origin,
      "蓝海",
      "蓝海机密附件字节",
    );
    await seed(reader, origin, "/join", {
      token: (await seed(page, origin, "/invitations", {})).token,
      name: "青山读者",
      email: "reader@example.test",
      password: "TeamSharing2026!",
    });
    const allowed = {
      page: [] as string[],
      other: [] as string[],
      visitor: ["GET /api/me 401"] as string[],
      reader: [] as string[],
    };
    const errors = [
      observeErrors(page, allowed.page),
      observeErrors(other, allowed.other),
      observeErrors(visitor, allowed.visitor),
      observeErrors(reader, allowed.reader),
    ];
    const foreignText = [
      "蓝海项目",
      "蓝海任务",
      "蓝海已提交工作",
      "蓝海成员",
      "蓝海日报",
      "蓝海机密附件字节",
      "blue@example.test",
    ];
    try {
      await page.goto(`${origin}/sharing`);
      await expect(
        page.getByRole("heading", { name: "公开链接", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("还没有生成公开链接。", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("combobox", { name: "分享内容", exact: true })
        .selectOption("project");
      const projects = page.getByRole("combobox", {
        name: "选择项目",
        exact: true,
      });
      await projects.selectOption(ownWork.project.id);
      await expect(projects.locator("option")).toHaveText([
        /请选择项目/,
        new RegExp(ownWork.project.name),
      ]);
      await page.getByLabel("开始日期", { exact: true }).fill(day);
      await page.getByLabel("结束日期", { exact: true }).fill(day);
      await page
        .getByRole("checkbox", { name: "进展日报", exact: true })
        .uncheck();
      const [created] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/shares" &&
            response.request().method() === "POST",
        ),
        page.getByRole("button", { name: "生成公开链接", exact: true }).click(),
      ]);
      expect(created.status()).toBe(201);
      const share = await created.json();
      expect(share).toMatchObject({
        type: "project",
        targetId: ownWork.project.id,
        targetName: ownWork.project.name,
        from: day,
        to: day,
        modules: ["overview", "tasks"],
        closed: false,
      });
      const link = await page
        .getByLabel("新公开链接", { exact: true })
        .inputValue();
      expect(link).toBe(`${origin}/share/${share.token}`);
      // 关闭链接后的公开页与正文请求是本用例刻意验证的失效结果。
      allowed.visitor.push(
        `GET /api/public/${share.token} 410`,
        `GET /share/${share.token} 410`,
      );
      await page.getByRole("button", { name: "复制链接", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("已复制");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        link,
      );
      await expect(
        page.getByRole("link", { name: "打开公开页" }),
      ).toHaveAttribute("href", `/share/${share.token}`);
      await noOverflow(page);

      // 团队日报链接开放进展模块，用于比较公开附件与完整日报的范围差异。
      const diaryLink = await seed(page, origin, "/shares", {
        type: "diary",
        from: day,
        to: day,
        modules: ["overview", "tasks", "progress"],
      });
      await page.reload();
      await expect(page.locator(".share-row")).toHaveCount(2);

      for (const current of [visitor, other, reader]) {
        await current.goto(link);
        await expect(
          current.getByRole("heading", {
            name: ownWork.project.name,
            exact: true,
          }),
        ).toBeVisible();
        await expect(current.locator(".overview-counts strong")).toHaveText([
          "1",
          "1",
          "1",
        ]);
        for (const text of foreignText)
          await expect(current.getByText(text, { exact: true })).toHaveCount(0);
        const body = await current.locator(".public-page").innerText();
        expect(body).not.toContain("draft");
        expect(body).not.toContain(ownWork.diary.published.entries[0].body);
        await noOverflow(current);
      }
      await expect(visitor.locator(".module-tabs button")).toHaveText([
        "概览",
        "任务列表",
      ]);
      await visitor
        .getByRole("button", { name: "任务列表", exact: true })
        .click();
      await expect(
        visitor.getByRole("heading", { name: ownWork.task.name }),
      ).toBeVisible();
      await expect(
        visitor.getByText(outsideWork.task.name, { exact: true }),
      ).toHaveCount(0);
      await noOverflow(visitor);

      await visitor.goto(`${origin}/share/${diaryLink.token}`);
      await expect(
        visitor.getByRole("heading", { name: "全团队日报", exact: true }),
      ).toBeVisible();
      await visitor
        .getByRole("button", { name: "进展日报", exact: true })
        .click();
      await expect(
        visitor.getByText(ownWork.diary.published.entries[0].body, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        visitor.getByText(outsideWork.diary.published.entries[0].body, {
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        visitor.getByRole("link", { name: ownWork.file.name }),
      ).toHaveAttribute(
        "href",
        `/api/public/${diaryLink.token}/attachments/${ownWork.file.id}`,
      );
      const download = await visitor.request.get(
        `${origin}/api/public/${diaryLink.token}/attachments/${ownWork.file.id}`,
      );
      expect(download.status()).toBe(200);
      expect(await download.body()).toEqual(Buffer.from(fileBytes));
      expect(download.headers()["content-type"]).toContain(
        "application/octet-stream",
      );
      expect(download.headers()["cache-control"]).toBe("no-store");
      // 未开放进展模块的链接不可读同一附件，也不能借他团队链接读取。
      expect(
        (
          await visitor.request.get(
            `${origin}/api/public/${share.token}/attachments/${ownWork.file.id}`,
          )
        ).status(),
      ).toBe(404);
      expect(
        (
          await visitor.request.get(
            `${origin}/api/public/${diaryLink.token}/attachments/${outsideWork.file.id}`,
          )
        ).status(),
      ).toBe(404);
      await noOverflow(visitor);

      for (const current of [other, reader]) {
        await current.goto(`${origin}/sharing`);
        await expect(
          current.getByText("还没有生成公开链接。", { exact: true }),
        ).toBeVisible();
        await expect(
          current.getByRole("button", { name: "关闭链接", exact: true }),
        ).toHaveCount(0);
        await noOverflow(current);
      }

      await page.getByRole("button", { name: "公开分享", exact: true }).click();
      await expect(page).toHaveURL(`${origin}/sharing`);
      const projectRow = page
        .locator(".share-row")
        .filter({ hasText: "青山项目" });
      await projectRow
        .getByRole("button", { name: "关闭链接", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText("链接已关闭");
      await expect(projectRow).toContainText("已关闭");
      await expect(
        page.locator(".share-row").filter({ hasText: "全团队日报" }),
      ).toContainText("进展日报");
      const closed = await visitor.request.get(
        `${origin}/api/public/${share.token}`,
      );
      expect(closed.status()).toBe(410);
      expect(await closed.json()).toEqual({
        error: "此公开链接无效或已关闭。",
      });
      expect(
        (
          await visitor.request.get(
            `${origin}/api/public/${share.token}/attachments/${ownWork.file.id}`,
          )
        ).status(),
      ).toBe(410);
      await visitor.goto(link);
      await expect(
        visitor.getByRole("heading", { name: "链接暂不可访问", exact: true }),
      ).toBeVisible();
      await expect(visitor.getByRole("alert")).toHaveText(
        "此公开链接无效或已关闭。",
      );
      await noOverflow(visitor);
      const stillOpen = await visitor.request.get(
        `${origin}/api/public/${diaryLink.token}`,
      );
      expect(stillOpen.status()).toBe(200);
      const text = JSON.stringify(await stillOpen.json());
      for (const secret of foreignText) expect(text).not.toContain(secret);
      expect(text).not.toContain("email");
      expect(own.team.id).not.toBe(outsider.team.id);
      expect(own.member.teamId).toBe(own.team.id);
    } finally {
      for (const observed of errors) expect.soft(observed).toEqual([]);
      await otherContext.close();
      await visitorContext.close();
      await readerContext.close();
    }
  });
}
