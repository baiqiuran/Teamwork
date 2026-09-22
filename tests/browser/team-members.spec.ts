import { expect, test as base, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../application.ts";

const joined = Date.parse("2026-09-15T02:00:00Z");
const invited = Date.parse("2026-09-16T02:00:00Z");
const submitted = Date.parse("2026-09-16T06:00:00Z");
const password = "MemberRoster2026!";

const test = base.extend<{
  service: { origin: string; setTime: (time: number) => void };
}>({
  service: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "daily-members-"));
    let time = joined;
    const app = await createApp({
      databasePath: join(directory, "test.sqlite"),
      staticDirectory: join(process.cwd(), "dist"),
      now: () => time,
    });
    try {
      const server = await app.listen(0, "127.0.0.1");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No address");
      await use({
        origin: `http://127.0.0.1:${address.port}`,
        setTime: (next) => {
          time = next;
        },
      });
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

async function read<T = any>(
  page: Page,
  origin: string,
  path: string,
): Promise<T> {
  const response = await page.request.get(`${origin}/api${path}`);
  expect(response.status(), path).toBe(200);
  return response.json();
}

function observeErrors(page: Page) {
  const allowed = new Set(["GET /api/me 401"]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) =>
    errors.push(`${request.failure()?.errorText} ${request.url()}`),
  );
  page.on("response", (response) => {
    const key = `${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`;
    if (response.status() >= 400 && !allowed.has(key)) errors.push(key);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const status = message
      .text()
      .match(
        /^Failed to load resource: the server responded with a status of (\d{3})\b/,
      )?.[1];
    const path = new URL(message.location().url || page.url()).pathname;
    if (!status || !allowed.has(`GET ${path} ${status}`))
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

const details = (page: Page) =>
  page.locator(".invitation-row .invitation-detail");

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`两个团队的成员名单、日期字段与邀请导航互不混淆 ${viewport.width}`, async ({
    page,
    browser,
    service,
  }) => {
    test.setTimeout(180_000);
    const { origin, setTime } = service;
    await page.setViewportSize(viewport);
    const invitedContext = await browser.newContext({ viewport });
    const outsideContext = await browser.newContext({ viewport });
    const invitee = await invitedContext.newPage();
    const outside = await outsideContext.newPage();
    await invitee.setViewportSize(viewport);
    await outside.setViewportSize(viewport);
    const errors = [
      observeErrors(page),
      observeErrors(invitee),
      observeErrors(outside),
    ];
    try {
      await page.goto(`${origin}/setup`);
      await page.getByLabel("团队名称", { exact: true }).fill("青山团队");
      await page.getByLabel("姓名", { exact: true }).fill("林晓");
      await page.getByLabel("邮箱", { exact: true }).fill("lin@example.test");
      await page.getByLabel("密码", { exact: true }).fill(password);
      await page.getByRole("button", { name: "创建团队并进入" }).click();
      // Login returns to the team roster, and the address matches the page.
      await expect(
        page.getByRole("heading", { name: "团队成员", exact: true }),
      ).toBeVisible();
      await expect(page).toHaveURL(`${origin}/members`);
      const creator = await read(page, origin, "/me");
      expect(creator.member).toMatchObject({
        name: "林晓",
        teamId: creator.team.id,
      });

      setTime(invited);
      const first = await seed(invitee, origin, "/join", {
        token: (await seed(page, origin, "/invitations", {})).token,
        name: "周宁",
        email: "zhou@example.test",
        password,
      });
      expect(first.member.teamId).toBe(creator.team.id);
      const draftEntry = { id: randomUUID(), body: "周宁仅草稿内容" };
      await seed(invitee, origin, "/diaries", {
        title: "周宁草稿",
        entries: [draftEntry],
      });
      await seed(invitee, origin, "/join", {
        token: (await seed(page, origin, "/invitations", {})).token,
        name: "陈安",
        email: "an@example.test",
        password,
      });
      const outsideIdentity = await seed(outside, origin, "/setup", {
        teamName: "蓝海团队",
        name: "蓝海成员",
        email: "blue@example.test",
        password,
      });
      expect(outsideIdentity.team.id).not.toBe(creator.team.id);

      setTime(submitted);
      const entry = { id: randomUUID(), body: "已提交的名单验证" };
      const diary = await seed(page, origin, "/diaries", {
        title: "名单日报",
        entries: [entry],
      });
      const uploaded = await seed(
        page,
        origin,
        `/diaries/${diary.id}/entries/${entry.id}/attachments`,
        {
          version: diary.version,
          requestId: randomUUID(),
          name: "名单.txt",
          base64: Buffer.from("名单附件").toString("base64"),
        },
      );
      await seed(
        page,
        origin,
        `/diaries/${diary.id}/submit`,
        { version: uploaded.version, requestId: randomUUID() },
        200,
      );

      // Existing ordering by name is kept: 周宁, 林晓, 陈安.
      await page.goto(`${origin}/members`);
      await expect(details(page)).toHaveCount(3);
      await expect(details(page).nth(0)).toContainText("周宁");
      await expect(details(page).nth(0)).toContainText(
        "加入于 2026-09-16 · 尚未提交",
      );
      await expect(details(page).nth(1)).toContainText("林晓");
      await expect(details(page).nth(1)).toContainText(
        "加入于 2026-09-15 · 最近提交 2026-09-16",
      );
      await expect(details(page).nth(2)).toContainText("陈安");
      await expect(details(page).nth(2)).toContainText(
        "加入于 2026-09-16 · 尚未提交",
      );
      const roster = await page.locator(".members-page").innerText();
      for (const hidden of [
        "lin@example.test",
        "zhou@example.test",
        "an@example.test",
        "blue@example.test",
        "蓝海成员",
        "周宁草稿",
        password,
      ])
        expect(roster).not.toContain(hidden);
      await expect(
        page.getByRole("button", { name: "团队成员", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await noOverflow(page);

      await invitee.goto(`${origin}/members`);
      await expect(details(invitee)).toHaveCount(3);
      await invitee
        .getByRole("button", { name: "成员邀请", exact: true })
        .click();
      await expect(invitee).toHaveURL(`${origin}/invitations`);
      await expect(
        invitee.getByRole("heading", { name: "成员邀请", exact: true }),
      ).toBeVisible();
      await invitee.reload();
      await expect(
        invitee.getByRole("heading", { name: "成员邀请", exact: true }),
      ).toBeVisible();
      await expect(
        invitee.getByRole("button", { name: "成员邀请", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await invitee
        .getByRole("button", { name: "团队成员", exact: true })
        .click();
      await expect(invitee).toHaveURL(`${origin}/members`);
      await noOverflow(invitee);

      await outside.goto(`${origin}/members`);
      await expect(details(outside)).toHaveCount(1);
      await expect(details(outside)).toContainText(
        "加入于 2026-09-16 · 尚未提交",
      );
      const outsideRoster = await outside.locator(".members-page").innerText();
      for (const hidden of ["林晓", "周宁", "陈安", "名单验证", "青山团队"])
        expect(outsideRoster).not.toContain(hidden);
      await noOverflow(outside);

      await invitee
        .getByRole("button", { name: "我的账号", exact: true })
        .click();
      await invitee
        .getByRole("button", { name: "退出登录", exact: true })
        .click();
      await expect(
        invitee.getByRole("heading", { name: "登录", exact: true }),
      ).toBeVisible();
      await invitee.goto(`${origin}/members`);
      await expect(
        invitee.getByRole("heading", { name: "登录", exact: true }),
      ).toBeVisible();
      await expect(details(invitee)).toHaveCount(0);
      await invitee.getByLabel("邮箱", { exact: true }).fill("an@example.test");
      await invitee.getByLabel("密码", { exact: true }).fill(password);
      await invitee.getByRole("button", { name: "登录", exact: true }).click();
      await expect(
        invitee.getByRole("heading", { name: "团队成员", exact: true }),
      ).toBeVisible();
      await expect(details(invitee).nth(0)).toContainText("周宁");
      await noOverflow(invitee);
    } finally {
      for (const observed of errors) expect.soft(observed).toEqual([]);
      await invitedContext.close();
      await outsideContext.close();
    }
  });
}
