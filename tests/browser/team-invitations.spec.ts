import { expect, test as base, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../application.ts";

const test = base.extend<{ origin: string }>({
  origin: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "daily-team-invitations-"));
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

function observeErrors(page: Page, revoked = false) {
  const allowed = [
    "GET /api/me 401",
    ...(revoked ? ["POST /api/invitations/preview 410"] : []),
  ];
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
    if (!status || !allowed.some((key) => key.endsWith(` ${path} ${status}`)))
      errors.push(message.text());
  });
  return errors;
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

async function post(
  page: Page,
  path: string,
  action: () => Promise<unknown>,
  status = 200,
) {
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api${path}` &&
      response.request().method() === "POST",
  );
  await action();
  const response = await pending;
  expect(response.status()).toBe(status);
  return response.json();
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`第二团队邀请的预览、加入及普通成员撤销 ${viewport.width}`, async ({
    page,
    browser,
    origin,
  }) => {
    const password = "TeamInvitation2026!";
    const teamIds: number[] = [];
    for (const [teamName, name, email] of [
      ["第一团队", "林晓", "first@example.test"],
      ["远山团队", "周宁", "second@example.test"],
    ]) {
      const seed = await browser.newContext();
      try {
        const response = await seed.request.post(`${origin}/api/setup`, {
          headers: { Origin: origin },
          data: { teamName, name, email, password },
        });
        expect(response.status()).toBe(201);
        const identity = await response.json();
        expect(identity).toMatchObject({
          team: { name: teamName },
          member: { name, email, teamId: identity.team.id },
        });
        teamIds.push(identity.team.id);
      } finally {
        await seed.close();
      }
    }
    expect(teamIds[1]).not.toBe(teamIds[0]);
    await page.setViewportSize(viewport);
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const joinedContext = await browser.newContext({ viewport });
    const blockedContext = await browser.newContext({ viewport });
    const joined = await joinedContext.newPage();
    const blocked = await blockedContext.newPage();
    const errors = [
      observeErrors(page),
      observeErrors(joined),
      observeErrors(blocked, true),
    ];
    try {
      await page.goto(`${origin}/login`);
      await page
        .getByLabel("邮箱", { exact: true })
        .fill("second@example.test");
      await page.getByLabel("密码", { exact: true }).fill(password);
      const login = await post(page, "/login", () =>
        page.getByRole("button", { name: "登录", exact: true }).click(),
      );
      expect(login.member.teamId).toBe(teamIds[1]);
      await expect(
        page.getByRole("heading", { name: "团队成员", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".invitation-row")).toHaveText([
        /周宁.*尚未提交/,
      ]);
      await noOverflow(page);
      await page.getByRole("button", { name: "成员邀请", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "成员邀请", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "生成邀请", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "邀请规则", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "还没有发出的邀请", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".invite-notes li")).toHaveText([
        "链接在 7 天内有效",
        "仅可使用一次，成功加入后自动失效",
        "仅生成者可以撤销尚未使用的邀请",
      ]);
      await noOverflow(page);
      const invitation = await post(
        page,
        "/invitations",
        () => page.getByRole("button", { name: "生成邀请链接" }).click(),
        201,
      );
      const url = await page.getByLabel("新邀请链接").inputValue();
      expect(url).toBe(`${origin}${invitation.joinPath}`);
      expect(new URL(url).pathname).toBe("/join");
      await expect(page.getByText("待接受", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "复制链接", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("已复制");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        url,
      );
      await noOverflow(page);

      const preview = await post(joined, "/invitations/preview", () =>
        joined.goto(url),
      );
      expect(preview).toMatchObject({
        team: { id: teamIds[1], name: "远山团队" },
        invitedBy: "周宁",
      });
      await expect(
        joined.getByRole("heading", { name: "加入远山团队", exact: true }),
      ).toBeVisible();
      await expect(
        joined.getByText("周宁 邀请你加入此团队。", { exact: true }),
      ).toBeVisible();
      await expect(joined.getByLabel("团队名称", { exact: true })).toHaveCount(
        0,
      );
      await noOverflow(joined);
      await joined.getByLabel("姓名", { exact: true }).fill("陈安");
      await joined
        .getByLabel("邮箱", { exact: true })
        .fill("joined@example.test");
      await joined.getByLabel("密码", { exact: true }).fill(password);
      const accepted = await post(
        joined,
        "/join",
        () =>
          joined.getByRole("button", { name: "加入团队", exact: true }).click(),
        201,
      );
      expect(accepted).toMatchObject({
        member: { name: "陈安", teamId: teamIds[1] },
        team: { id: teamIds[1], name: "远山团队" },
      });
      const me = await joined.request.get(`${origin}/api/me`);
      expect(me.status()).toBe(200);
      expect(await me.json()).toMatchObject({
        member: {
          id: accepted.member.id,
          teamId: teamIds[1],
          email: "joined@example.test",
        },
        team: { id: teamIds[1], name: "远山团队" },
      });
      await expect(joined.locator(".team-badge")).toContainText("远山团队");
      await expect(
        joined.getByRole("heading", { name: "团队成员", exact: true }),
      ).toBeVisible();
      await expect(joined.locator(".invitation-row")).toHaveText([
        /周宁.*尚未提交/,
        /陈安.*尚未提交/,
      ]);
      await expect(joined.getByText("林晓", { exact: true })).toHaveCount(0);
      await expect(joined.getByText("第一团队", { exact: true })).toHaveCount(
        0,
      );
      await noOverflow(joined);
      await joined
        .getByRole("button", { name: "成员邀请", exact: true })
        .click();
      await expect(
        joined.getByRole("heading", { name: "还没有发出的邀请", exact: true }),
      ).toBeVisible();
      await expect(joined).toHaveURL(`${origin}/invitations`);
      const own = await post(
        joined,
        "/invitations",
        () => joined.getByRole("button", { name: "生成邀请链接" }).click(),
        201,
      );
      const revokedUrl = await joined.getByLabel("新邀请链接").inputValue();
      await expect(joined.locator(".invitation-row")).toHaveCount(1);
      await post(joined, `/invitations/${own.invitation.id}/revoke`, () =>
        joined.getByRole("button", { name: "撤销", exact: true }).click(),
      );
      await expect(joined.getByText("已撤销", { exact: true })).toBeVisible();
      await expect(joined.getByLabel("新邀请链接")).toHaveCount(0);
      await expect(
        joined.getByRole("button", { name: "撤销", exact: true }),
      ).toHaveCount(0);
      await noOverflow(joined);
      await page.getByRole("button", { name: "刷新列表" }).click();
      await expect(page.getByText("已接受", { exact: true })).toBeVisible();
      await expect(page.getByLabel("新邀请链接")).toHaveCount(0);

      const unavailable = await post(
        blocked,
        "/invitations/preview",
        () => blocked.goto(revokedUrl),
        410,
      );
      await expect(blocked.getByRole("alert")).toHaveText(unavailable.error);
      await expect(blocked.getByRole("alert")).toContainText("邀请无效");
      await expect(blocked.locator("form")).toHaveCount(0);
      await expect(
        blocked.getByRole("button", { name: "加入团队", exact: true }),
      ).toHaveCount(0);
      await expect(blocked.locator(".team-badge")).toHaveCount(0);
      expect((await blocked.request.get(`${origin}/api/me`)).status()).toBe(
        401,
      );
      await noOverflow(blocked);
      for (const observed of errors) expect(observed).toEqual([]);
    } finally {
      await joinedContext.close();
      await blockedContext.close();
    }
  });
}
