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
  await expect(
    panel.getByRole("button", { name: "显示 Key", exact: true }),
  ).toBeVisible();
  await expect(field).toHaveCount(0);
  await panel.getByRole("button", { name: "显示 Key", exact: true }).click();
  await expect(field).toHaveValue(/^dfk_/);
  const key = await field.inputValue();
  await panel
    .getByRole("button", { name: "隐藏 Key 正文", exact: true })
    .click();
  await expect(field).toHaveCount(0);
  expect(await page.content()).not.toContain(key);
  await panel.getByRole("button", { name: "复制 Key", exact: true }).click();
  await expect(panel.getByRole("status").first()).toContainText("已复制Key");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
  const address = panel.getByLabel("服务地址", { exact: true });
  await expect(address).toHaveValue(`${origin}/mcp`);
  await panel
    .getByLabel("本地包路径")
    .fill("C:/tools/daily-flow-mcp-0.1.0.tgz");
  await panel
    .getByLabel("密钥文件路径", { exact: true })
    .fill("C:/Users/本地 成员/.daily-flow/member.key");
  const configurationField = panel.getByLabel("Codex 配置", { exact: true });
  const copyConfiguration = panel.getByRole("button", {
    name: "复制 Codex 配置",
    exact: true,
  });
  await address.fill("https://daily.example.test");
  await expect(configurationField).toHaveValue(
    /DAILY_FLOW_URL = "https:\/\/daily\.example\.test\/mcp"/,
  );
  await expect(panel.getByText(/会发送到此地址/)).toBeVisible();
  await address.fill("http://daily.example.test/mcp");
  await expect(address).toHaveAttribute("aria-invalid", "true");
  await expect(configurationField).toHaveValue("请先填写有效的服务地址。");
  await expect(copyConfiguration).toBeDisabled();
  await address.fill(`${origin}/mcp`);
  await expect(copyConfiguration).toBeEnabled();
  const configuration = await configurationField.inputValue();
  await copyConfiguration.click();
  await expect(panel.getByRole("status").first()).toContainText(
    "已复制Codex 配置",
  );
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.replace(/\r\n/g, "\n")).toBe(configuration);
  expect(configuration).toContain("[mcp_servers.daily_flow_node]");
  expect(configuration).toContain('command = "cmd"');
  expect(configuration).toContain(
    "--package=C:/tools/daily-flow-mcp-0.1.0.tgz",
  );
  expect(configuration).toContain(`DAILY_FLOW_URL = "${origin}/mcp"`);
  expect(configuration).toContain(
    'DAILY_FLOW_API_KEY_FILE = "C:/Users/本地 成员/.daily-flow/member.key"',
  );
  expect(configuration).not.toContain("DAILY_FLOW_API_KEY =");
  expect(configuration).not.toContain(key);
  expect(copied).not.toContain(key);
  expect(await page.content()).not.toContain(key);
  await expect(panel.getByLabel("本地包路径")).toBeVisible();
  await panel
    .getByRole("button", { name: "返回连接管理", exact: true })
    .click();
  return { panel, key };
}

test("连接管理默认显示，键盘页签只呈现对应内容", async ({ page, origin }) => {
  const errors = observeErrors(page);
  await createTeam(page, origin, "页签", "tabs@example.test");
  await page.goto(`${origin}/ai`);
  const management = page.getByRole("tab", { name: "连接管理", exact: true });
  const history = page.getByRole("tab", { name: "操作记录", exact: true });
  await expect(management).toHaveAttribute("aria-selected", "true");
  await expect(history).toHaveAttribute("tabindex", "-1");
  await expect(page.getByRole("tabpanel", { name: "连接管理" })).toBeVisible();
  await expect(page.getByText("暂无连接。", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "AI 操作记录" }),
  ).not.toBeVisible();
  await page
    .getByRole("button", { name: "通过 Node 连接", exact: true })
    .click();
  const keyPanel = page.getByRole("region", { name: "Node 授权 Key" });
  await keyPanel.getByLabel("连接名称", { exact: true }).fill("未完成的配置");

  await management.focus();
  await management.press("ArrowRight");
  await expect(history).toBeFocused();
  await expect(history).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "操作记录" })).toBeVisible();
  await expect(page.getByText("暂无操作记录。", { exact: true })).toBeVisible();
  await expect(keyPanel).not.toBeVisible();
  await expect(
    page.getByRole("region", { name: "已有连接" }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "连接 Codex", exact: true }),
  ).not.toBeVisible();
  await history.press("Tab");
  await expect(page.getByRole("tabpanel", { name: "操作记录" })).toBeFocused();
  await history.focus();
  await history.press("ArrowRight");
  await expect(management).toBeFocused();
  await expect(keyPanel).toHaveCount(0);
  await expect(page.getByRole("region", { name: "已有连接" })).toBeVisible();
  await management.press("ArrowLeft");
  await expect(history).toBeFocused();
  await history.press("Home");
  await expect(management).toBeFocused();
  await management.press("End");
  await expect(history).toBeFocused();
  expect(
    await history.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe("none");
  await management.click();
  await expect(
    page.getByRole("region", { name: "AI 操作记录" }),
  ).not.toBeVisible();
  await expect(keyPanel).toHaveCount(0);
  await page
    .getByRole("button", { name: "通过 Node 连接", exact: true })
    .click();
  await expect(keyPanel.getByLabel("连接名称", { exact: true })).toHaveValue(
    "我的 Node 客户端",
  );
  expect(errors).toEqual([]);
});

test("连接加载失败不冒充空列表，恢复会话后可以重试", async ({
  page,
  origin,
}, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await createTeam(page, origin, "重试", "retry@example.test");
  await page.goto(`${origin}/account`);
  await expect(
    page.getByRole("heading", { name: "我的账号", exact: true }),
  ).toBeVisible();
  expect(
    (
      await page.request.post(`${origin}/api/logout`, {
        headers: { Origin: origin },
        data: {},
      })
    ).ok(),
  ).toBe(true);
  // Slow the actual network, without substituting an application response.
  const network = await page.context().newCDPSession(page);
  await network.send("Network.enable");
  await network.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 1000,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  const denied = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/ai/connections" &&
      response.status() === 401,
  );
  await page
    .getByRole("navigation", { name: "团队导航" })
    .getByRole("button", { name: "AI 连接", exact: true })
    .click();
  const loading = page.getByRole("status").filter({ hasText: "正在加载连接" });
  await expect(loading).toBeVisible();
  await expect(page.getByText("暂无连接。", { exact: true })).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "刷新连接", exact: true }),
  ).toBeDisabled();
  await denied;
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(loading).not.toBeVisible();
  await expect(page.getByText("暂无连接。", { exact: true })).not.toBeVisible();
  const retry = page.getByRole("button", { name: "重试加载连接", exact: true });
  await expect(retry).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("connections-error.png") });
  expect(
    (
      await page.request.post(`${origin}/api/login`, {
        headers: { Origin: origin },
        data: { email: "retry@example.test", password: "McpScope2026!" },
      })
    ).ok(),
  ).toBe(true);
  await retry.click();
  await expect(loading).toBeVisible();
  await expect(
    page.getByRole("button", { name: "刷新连接", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("暂无连接。", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "刷新连接", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "连接 Codex", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "通过 Node 连接", exact: true }),
  ).toBeEnabled();
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([
    expect.stringMatching(/401 \(Unauthorized\)/),
  ]);
  await network.detach();
});

test("连接以紧凑单列呈现名称、类型、真实查询状态和集中操作", async ({
  page,
  origin,
}, testInfo) => {
  const errors = observeErrors(page);
  await createTeam(page, origin, "列表", "rows@example.test");
  const issued: { id: string; key: string }[] = [];
  for (const name of ["待测试桌面助手", "已验证桌面助手", "已停用桌面助手"]) {
    const response = await page.request.post(`${origin}/api/ai/keys`, {
      headers: { Origin: origin },
      data: { name, scopes: ["progress:read", "drafts:write"] },
    });
    expect(response.status()).toBe(201);
    issued.push(await response.json());
  }
  const client = await mcpClient(origin, issued[1].key);
  try {
    expect(
      (await client.callTool({ name: "list_projects", arguments: {} })).isError,
    ).not.toBe(true);
    expect(
      (
        await page.request.post(
          `${origin}/api/ai/connections/${issued[2].id}/revoke`,
          {
            headers: { Origin: origin },
            data: {},
          },
        )
      ).ok(),
    ).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/ai`);
    const rows = page.locator(".ai-connection-card");
    await expect(rows).toHaveCount(3);
    const boxes = await rows.evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
    for (let index = 1; index < boxes.length; index++) {
      expect(boxes[index].y).toBeGreaterThanOrEqual(
        boxes[index - 1].y + boxes[index - 1].height,
      );
      expect(boxes[index].x).toBe(boxes[0].x);
      expect(boxes[index].width).toBe(boxes[0].width);
    }
    for (const box of boxes) expect(box.height).toBeLessThanOrEqual(200);
    const pending = rows.filter({
      has: page.getByRole("heading", { name: "待测试桌面助手", exact: true }),
    });
    const connected = rows.filter({
      has: page.getByRole("heading", { name: "已验证桌面助手", exact: true }),
    });
    const revoked = rows.filter({
      has: page.getByRole("heading", { name: "已停用桌面助手", exact: true }),
    });
    await expect(
      pending.getByText("Node · 授权 Key", { exact: true }),
    ).toBeVisible();
    await expect(pending.getByText("待测试", { exact: true })).toBeVisible();
    await expect(connected.getByText("已连接", { exact: true })).toBeVisible();
    await expect(connected.getByText(/最近成功查询：/)).toBeVisible();
    await expect(revoked.getByText("已撤销", { exact: true })).toBeVisible();
    const heading = await pending.getByRole("heading").boundingBox();
    const action = await pending
      .getByRole("button", { name: "更换 Key / 调整能力", exact: true })
      .boundingBox();
    expect(action!.x).toBeGreaterThan(heading!.x + heading!.width);
    await expect(
      pending.getByRole("button", { name: "撤销连接", exact: true }),
    ).toBeEnabled();
    await expect(
      revoked.getByRole("button", { name: "删除记录", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("connections-1440.png"),
    });
    for (const width of [720, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${width} 横向溢出`,
      ).toBe(true);
      await pending
        .getByRole("button", { name: "更换 Key / 调整能力", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        pending.getByRole("button", { name: "撤销连接", exact: true }),
      ).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: testInfo.outputPath(`connections-${width}.png`),
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
  } finally {
    await client.close();
  }
});

test("多条 Key 可返回、导航、刷新、重新登录及独立浏览器回看，不留浏览器存储", async ({
  page,
  browser,
  origin,
}) => {
  await createTeam(page, origin, "回看", "review@example.test");
  const keys: { id: string; key: string; name: string }[] = [];
  for (const name of ["第一条", "第二条"]) {
    const response = await page.request.post(`${origin}/api/ai/keys`, {
      headers: { Origin: origin },
      data: { name, scopes: ["progress:read"] },
    });
    expect(response.status()).toBe(201);
    keys.push(await response.json());
  }
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const open = async (current: Page, index: number) => {
    const row = current.getByRole("article").filter({
      has: current.getByRole("heading", {
        name: keys[index].name,
        exact: true,
      }),
    });
    await row
      .getByRole("button", { name: "查看 Key / 配置", exact: true })
      .click();
    const panel = current.getByRole("region", {
      name: "查看 Node 授权 Key",
      exact: true,
    });
    await expect(
      panel.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveCount(0);
    return panel;
  };
  const reveal = async (current: Page, index: number) => {
    const panel = await open(current, index);
    await panel.getByRole("button", { name: "显示 Key", exact: true }).click();
    await expect(
      panel.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveValue(keys[index].key);
    return panel;
  };
  const login = async (current: Page) => {
    await current
      .getByLabel("邮箱", { exact: true })
      .fill("review@example.test");
    await current.getByLabel("密码", { exact: true }).fill("McpScope2026!");
    await current.getByRole("button", { name: "登录", exact: true }).click();
    await current
      .getByRole("navigation", { name: "团队导航" })
      .getByRole("button", { name: "AI 连接", exact: true })
      .click();
  };
  await page.goto(`${origin}/ai`);
  const first = await reveal(page, 0);
  await first
    .getByRole("button", { name: "返回连接管理", exact: true })
    .click();
  expect(await page.content()).not.toContain(keys[0].key);
  await reveal(page, 1);
  await page.getByRole("tab", { name: "操作记录", exact: true }).click();
  expect(await page.content()).not.toContain(keys[1].key);
  await page.getByRole("tab", { name: "连接管理", exact: true }).click();
  await reveal(page, 1);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "团队成员", exact: true })
    .click();
  expect(await page.content()).not.toContain(keys[1].key);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "AI 连接", exact: true })
    .click();
  await reveal(page, 0);
  await page.reload();
  await reveal(page, 1);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "我的账号", exact: true })
    .click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "登录", exact: true }),
  ).toBeVisible();
  for (const entry of keys)
    expect(await page.content()).not.toContain(entry.key);
  await login(page);
  const afterLogin = await reveal(page, 0);
  await afterLogin
    .getByRole("button", { name: "隐藏 Key 正文", exact: true })
    .click();
  const independent = await browser.newContext();
  try {
    const device = await independent.newPage();
    const deviceErrors: string[] = [];
    device.on("pageerror", (error) => deviceErrors.push(error.message));
    await independent.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin,
    });
    await device.goto(`${origin}/login`);
    await login(device);
    const panel = await open(device, 1);
    await panel.getByRole("button", { name: "复制 Key", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("已复制Key");
    expect(await device.evaluate(() => navigator.clipboard.readText())).toBe(
      keys[1].key,
    );
    await expect(
      panel.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveCount(0);
    for (const current of [page, device]) {
      const storage = await current.evaluate(async () => ({
        local: { ...localStorage },
        session: { ...sessionStorage },
        caches: await caches.keys(),
      }));
      for (const entry of keys)
        expect(JSON.stringify(storage)).not.toContain(entry.key);
      expect(storage.caches).toEqual([]);
      expect(
        (
          await (
            await current.request.get(`${origin}/api/ai/connections`)
          ).json()
        ).map(
          (c: { lastReadSucceededAt: number | null }) => c.lastReadSucceededAt,
        ),
      ).toEqual([null, null]);
    }
    expect(deviceErrors).toEqual([]);
  } finally {
    await independent.close();
  }
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([
    expect.stringMatching(/401 \(Unauthorized\)/),
  ]);
});

test("隐藏或切换连接后不恢复延迟返回的 Key 正文", async ({ page, origin }) => {
  await createTeam(page, origin, "延迟回看", "delayed-review@example.test");
  const issued: { id: string; key: string }[] = [];
  for (const name of ["延迟一", "延迟二"])
    issued.push(
      await (
        await page.request.post(`${origin}/api/ai/keys`, {
          headers: { Origin: origin },
          data: { name, scopes: ["progress:read"] },
        })
      ).json(),
    );
  const errors = observeErrors(page);
  await page.goto(`${origin}/ai`);
  const row = (name: string) =>
    page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
  const panel = page.getByRole("region", {
    name: "查看 Node 授权 Key",
    exact: true,
  });
  for (const action of ["hide", "tab", "connection"] as const) {
    await row("延迟一")
      .getByRole("button", { name: "查看 Key / 配置" })
      .click();
    let release!: () => void;
    let received!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      received = resolve;
    });
    // Delay an actual authenticated response, without substituting its data.
    await page.route(
      `**/api/ai/connections/${issued[0].id}/key`,
      async (route) => {
        const response = await route.fetch();
        received();
        await gate;
        await route.fulfill({ response });
      },
    );
    const delivered = page.waitForResponse((response) =>
      response.url().endsWith(`/connections/${issued[0].id}/key`),
    );
    await panel.getByRole("button", { name: "显示 Key", exact: true }).click();
    await ready;
    if (action === "hide")
      await panel
        .getByRole("button", { name: "我已保存，隐藏 Key", exact: true })
        .click();
    else if (action === "tab")
      await page.getByRole("tab", { name: "操作记录", exact: true }).click();
    else {
      await panel
        .getByRole("button", { name: "返回连接管理", exact: true })
        .click();
      await row("延迟二")
        .getByRole("button", { name: "查看 Key / 配置" })
        .click();
    }
    release();
    await (await delivered).finished();
    await page.unroute(`**/api/ai/connections/${issued[0].id}/key`);
    if (action === "tab") {
      await page.getByRole("tab", { name: "连接管理", exact: true }).click();
      await row("延迟一")
        .getByRole("button", { name: "查看 Key / 配置" })
        .click();
    }
    await expect(
      panel.getByRole("button", { name: "显示 Key", exact: true }),
    ).toBeEnabled();
    await expect(
      panel.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveCount(0);
    expect(await page.content()).not.toContain(issued[0].key);
    await panel.getByRole("button", { name: "显示 Key", exact: true }).click();
    await expect(
      panel.getByRole("textbox", { name: "授权 Key", exact: true }),
    ).toHaveValue(issued[action === "connection" ? 1 : 0].key);
    await panel
      .getByRole("button", { name: "返回连接管理", exact: true })
      .click();
  }
  expect(errors).toEqual([]);
});

test("撤销后复制重新核权，本页撤销成功即使刷新失败也清除正文和入口", async ({
  page,
  origin,
}, testInfo) => {
  await createTeam(page, origin, "撤销回看", "revoke-review@example.test");
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const issued: { id: string; key: string }[] = [];
  for (const name of ["外部撤销", "本页撤销"]) {
    issued.push(
      await (
        await page.request.post(`${origin}/api/ai/keys`, {
          headers: { Origin: origin },
          data: { name, scopes: ["progress:read"] },
        })
      ).json(),
    );
  }
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(`${origin}/ai`);
  const row = (name: string) =>
    page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
  const panel = page.getByRole("region", {
    name: "查看 Node 授权 Key",
    exact: true,
  });
  await row("外部撤销")
    .getByRole("button", { name: "查看 Key / 配置" })
    .click();
  await panel.getByRole("button", { name: "显示 Key", exact: true }).click();
  await expect(
    panel.getByRole("textbox", { name: "授权 Key", exact: true }),
  ).toHaveValue(issued[0].key);
  expect(
    (
      await page.request.post(
        `${origin}/api/ai/connections/${issued[0].id}/revoke`,
        { headers: { Origin: origin }, data: {} },
      )
    ).ok(),
  ).toBe(true);
  await page.evaluate(() => navigator.clipboard.writeText("unchanged"));
  await panel.getByRole("button", { name: "复制 Key", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("不能回看");
  await expect(
    panel.getByRole("textbox", { name: "授权 Key", exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "unchanged",
  );
  await panel
    .getByRole("button", { name: "返回连接管理", exact: true })
    .click();
  await row("本页撤销")
    .getByRole("button", { name: "查看 Key / 配置" })
    .click();
  await panel.getByRole("button", { name: "显示 Key", exact: true }).click();
  await expect(
    panel.getByRole("textbox", { name: "授权 Key", exact: true }),
  ).toHaveValue(issued[1].key);
  // Fail only the follow-up network read, not the real revoke response.
  await page.route("**/api/ai/connections", (route) => route.abort("failed"));
  await panel.getByRole("button", { name: "撤销连接", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("连接加载失败");
  await expect(panel).toHaveCount(0);
  await expect(
    row("本页撤销").getByRole("button", { name: "查看 Key / 配置" }),
  ).toHaveCount(0);
  await expect(
    row("本页撤销").getByText("已撤销", { exact: true }),
  ).toBeVisible();
  for (const entry of issued)
    expect(await page.content()).not.toContain(entry.key);
  await page.screenshot({
    path: testInfo.outputPath("revoked-refresh-failed.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([
    expect.stringMatching(/404 \(Not Found\)/),
    expect.stringMatching(/net::ERR_FAILED/),
  ]);
});

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
