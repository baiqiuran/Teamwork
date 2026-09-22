import { expect, test as base, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../application.ts";

const test = base.extend<{
  site: { origin: string; restart: () => Promise<void> };
}>({
  site: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "daily-team-creation-"));
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    let port = 0;
    async function start() {
      app = await createApp({
        databasePath: join(directory, "test.sqlite"),
        staticDirectory: join(process.cwd(), "dist"),
      });
      const server = await app.listen(port, "127.0.0.1");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No address");
      port = address.port;
    }
    try {
      await start();
      await use({
        origin: `http://127.0.0.1:${port}`,
        restart: async () => {
          await app?.close();
          await start();
        },
      });
    } finally {
      try {
        await app?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
});

type Registration = {
  teamName: string;
  name: string;
  email: string;
  password: string;
};
const first: Registration = {
  teamName: "Team",
  name: "林晓",
  email: "lin@example.test",
  password: "QuietRiver2026!",
};
const second: Registration = {
  teamName: "远山团队",
  name: "周宁",
  email: "zhou@example.test",
  password: "SecondMember2026!",
};
const retry: Registration = {
  teamName: "重试团队",
  name: "陈安",
  email: "chen@example.test",
  password: "AnotherMember2026!",
};

function observeErrors(page: Page, expectedFailures: string[] = []) {
  const allowed = new Set(["GET /api/me 401", ...expectedFailures]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText;
    // Full-page navigation can cancel a request from the page being left.
    if (failure !== "net::ERR_ABORTED")
      errors.push(`${failure} ${request.url()}`);
  });
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
    if (
      status &&
      [...allowed].some((key) => key.endsWith(` ${path} ${status}`))
    )
      return;
    errors.push(message.text());
  });
  return errors;
}

async function noOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
}

async function setupForm(page: Page) {
  await expect(
    page.getByRole("heading", { name: "创建团队", exact: true }),
  ).toBeVisible();
  await expect(page.locator("form input")).toHaveCount(4);
  for (const label of ["团队名称", "姓名", "邮箱", "密码"]) {
    const input = page.getByLabel(label, { exact: true });
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute("required", "");
  }
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute(
    "minlength",
    "12",
  );
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute(
    "maxlength",
    "128",
  );
  await expect(
    page.getByLabel("密码", { exact: true }),
  ).toHaveAccessibleDescription("使用至少 12 个字符，可包含字母、数字和符号。");
  await noOverflow(page);
}

async function submitSetup(
  page: Page,
  registration: Registration,
  status = 201,
) {
  await page
    .getByLabel("团队名称", { exact: true })
    .fill(registration.teamName);
  await page.getByLabel("姓名", { exact: true }).fill(registration.name);
  await page.getByLabel("邮箱", { exact: true }).fill(registration.email);
  await page.getByLabel("密码", { exact: true }).fill(registration.password);
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/setup" &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "创建团队并进入", exact: true })
    .click();
  const response = await pending;
  expect(response.request().postDataJSON()).toEqual(registration);
  expect(response.status()).toBe(status);
  return response;
}

async function identityIs(page: Page, registration: Registration) {
  await expect(page.locator(".team-badge")).toContainText(
    registration.teamName,
  );
  await page.getByRole("button", { name: "我的账号", exact: true }).click();
  const account = page.locator(".account-card");
  for (const value of [
    registration.name,
    registration.email,
    registration.teamName,
  ])
    await expect(account.getByText(value, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await noOverflow(page);
}

async function loginForm(page: Page) {
  await expect(
    page.getByRole("heading", { name: "登录", exact: true }),
  ).toBeVisible();
  await expect(page.locator("form input")).toHaveCount(2);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "创建新团队 →", exact: true }),
  ).toHaveAttribute("href", "/setup");
  await expect(page.locator(".access-note")).toContainText(
    "加入已有团队需获取成员发出的邀请链接。",
  );
  await noOverflow(page);
}

async function logout(page: Page) {
  const pending = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/logout",
  );
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  expect((await pending).status()).toBe(200);
  await loginForm(page);
  await expect(page.locator(".team-badge")).toHaveCount(0);
}

async function login(page: Page, registration: Registration) {
  await loginForm(page);
  await page.getByLabel("邮箱", { exact: true }).fill(registration.email);
  await page.getByLabel("密码", { exact: true }).fill(registration.password);
  const pending = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/login",
  );
  await page.getByLabel("密码", { exact: true }).press("Enter");
  const response = await pending;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({
    email: registration.email,
    password: registration.password,
  });
  await identityIs(page, registration);
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`访客只填写四项信息即可创建团队 ${viewport.width}`, async ({
    page,
    site,
  }) => {
    const errors = observeErrors(page, ["POST /api/invitations/preview 410"]);
    await page.setViewportSize(viewport);
    await page.goto(`${site.origin}/setup`);
    await setupForm(page);
    await page
      .getByRole("link", { name: "已有账号？前往登录 →", exact: true })
      .click();
    await loginForm(page);

    // Even on an empty site, /join remains an invitation route, not setup.
    await page.goto(`${site.origin}/join#invite=invalid-invitation`);
    await expect(page.getByRole("alert")).toContainText("邀请无效");
    await expect(page.locator("form")).toHaveCount(0);
    await noOverflow(page);
    await page.goto(`${site.origin}/`);
    await setupForm(page);
    await page
      .getByRole("link", { name: "已有账号？前往登录 →", exact: true })
      .click();
    await loginForm(page);
    await page.getByRole("link", { name: "创建新团队 →", exact: true }).click();
    await setupForm(page);

    // Obsolete setup keys and unrelated invite hashes never enter the payload.
    await page.goto(`${site.origin}/setup#key=obsolete&invite=unrelated`);
    await setupForm(page);
    await submitSetup(page, first);
    await identityIs(page, first);
    await logout(page);
    await page.goto(`${site.origin}/login#invite=unrelated`);
    await login(page, first);
    expect(errors).toEqual([]);
  });

  test(`独立团队、冲突恢复与重启后的账号归属 ${viewport.width}`, async ({
    page,
    browser,
    site,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize(viewport);
    const secondContext = await browser.newContext({ viewport });
    const visitorContext = await browser.newContext({ viewport });
    const secondPage = await secondContext.newPage();
    const visitor = await visitorContext.newPage();
    const errors = [
      observeErrors(page),
      observeErrors(secondPage),
      observeErrors(visitor, ["POST /api/setup 409"]),
    ];
    try {
      await page.goto(`${site.origin}/setup`);
      await setupForm(page);
      await submitSetup(page, first);
      await identityIs(page, first);

      await secondPage.goto(`${site.origin}/login`);
      await loginForm(secondPage);
      await secondPage
        .getByRole("link", { name: "创建新团队 →", exact: true })
        .click();
      await setupForm(secondPage);
      await submitSetup(secondPage, second);
      await identityIs(secondPage, second);

      await visitor.goto(`${site.origin}/login`);
      await loginForm(visitor);
      await visitor
        .getByRole("link", { name: "创建新团队 →", exact: true })
        .click();
      await setupForm(visitor);
      for (const teamName of ["team", "Ｔｅａｍ", " Team "]) {
        const response = await submitSetup(
          visitor,
          { ...retry, teamName },
          409,
        );
        expect((await response.json()).error).toBe(
          "团队名称已被使用，请更换名称。",
        );
        await expect(visitor.getByRole("alert")).toHaveText(
          "团队名称已被使用，请更换名称。",
        );
        await expect(visitor.locator(".team-badge")).toHaveCount(0);
        await expect(visitor.getByLabel("邮箱", { exact: true })).toHaveValue(
          retry.email,
        );
        await noOverflow(visitor);
      }
      const response = await submitSetup(
        visitor,
        { ...retry, email: first.email },
        409,
      );
      expect((await response.json()).error).toBe("此邮箱已注册，请直接登录。");
      await expect(visitor.getByRole("alert")).toHaveText(
        "此邮箱已注册，请直接登录。",
      );
      await expect(visitor.locator(".team-badge")).toHaveCount(0);
      await noOverflow(visitor);
      await visitor
        .getByRole("link", { name: "已有账号？前往登录 →", exact: true })
        .click();
      await login(visitor, first);
      await logout(visitor);

      await site.restart();
      for (const [ownerPage, registration] of [
        [page, first],
        [secondPage, second],
      ] as const) {
        await ownerPage.reload();
        await identityIs(ownerPage, registration);
        // An authenticated visitor keeps their own account on either entry route.
        for (const path of ["/login", "/setup"]) {
          await ownerPage.goto(`${site.origin}${path}`);
          await identityIs(ownerPage, registration);
        }
        await logout(ownerPage);
        await login(ownerPage, registration);
      }

      // The failed email/name attempts left neither a reserved name nor an account.
      await visitor.goto(`${site.origin}/setup`);
      await setupForm(visitor);
      await submitSetup(visitor, retry);
      await identityIs(visitor, retry);
      await logout(visitor);
      await login(visitor, retry);
      await page.reload();
      await identityIs(page, first);
      await secondPage.reload();
      await identityIs(secondPage, second);
      for (const observed of errors) expect(observed).toEqual([]);
    } finally {
      await visitorContext.close();
      await secondContext.close();
    }
  });
}
