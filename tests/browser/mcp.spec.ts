import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createApp } from "../application.ts";
import { mcpClient } from "../mcp-support.ts";
test("授权默认项、取消、真实操作记录与对象定位、撤销后网页仍能查看", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "daily-mcp-ui-")),
    app = await createApp({
      databasePath: join(directory, "test.sqlite"),
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
        name: "验收成员",
        email: "ui@example.test",
        password: "BrowserFixture2026!",
        teamName: "隔离团队",
      },
    });
    expect(setup.status()).toBe(201);
    await page.goto(`${origin}/ai`);
    await page.getByRole("button", { name: "连接 Codex", exact: true }).click();
    const guide = page.getByRole("region", { name: "连接 Codex 指引" });
    const remoteAddress = guide.getByLabel("远程 MCP 服务器地址");
    const configuration = guide.getByLabel("Codex 服务器配置");
    const copyConfiguration = guide.getByRole("button", {
      name: "复制服务器配置",
    });
    await expect(remoteAddress).toHaveValue(`${origin}/mcp`);
    await expect(configuration).toHaveValue(
      new RegExp(`url = "${origin.replaceAll(".", "\\.")}/mcp"`),
    );
    await remoteAddress.fill("https://daily.example.test");
    await expect(configuration).toHaveValue(
      /url = "https:\/\/daily\.example\.test\/mcp"/,
    );
    await expect(configuration).toHaveValue(/client_id = "daily-flow-codex"/);
    await expect(configuration).toHaveValue(
      /callback_url = "http:\/\/127\.0\.0\.1\/callback"/,
    );
    await remoteAddress.fill("http://daily.example.test/mcp");
    await expect(remoteAddress).toHaveAttribute("aria-invalid", "true");
    await expect(copyConfiguration).toBeDisabled();
    await remoteAddress.fill(`${origin}/mcp`);
    await guide.getByLabel("Codex 连接名称").fill("team_daily");
    await expect(configuration).toHaveValue(/\[mcp_servers\.team_daily\]/);
    await expect(guide.getByLabel("授权命令")).toHaveValue(
      "codex mcp login team_daily --scopes progress:read,drafts:write",
    );
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await copyConfiguration.click();
    expect(
      (await page.evaluate(() => navigator.clipboard.readText())).replace(
        /\r\n/g,
        "\n",
      ),
    ).toBe(await configuration.inputValue());
    const verifier = "t".repeat(43),
      request = {
        client_id: "daily-flow-codex",
        resource: `${origin}/mcp`,
        redirect_uri: "http://127.0.0.1:19876/callback",
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        state: "browser-state",
        scope:
          "progress:read drafts:write diaries:submit tasks:write shares:manage",
      };
    await page.route("http://127.0.0.1:19876/callback**", (route) =>
      route.fulfill({ body: "取消完成" }),
    );
    await page.goto(
      `${origin}/oauth/authorize?${new URLSearchParams(request)}`,
    );
    await expect(page.getByLabel("查询团队工作进展")).toBeChecked();
    await expect(page.getByLabel("提交本人日报")).not.toBeChecked();
    await page.getByRole("button", { name: "取消授权" }).click();
    await expect(page).toHaveURL(/error=access_denied/);
    expect(
      await (await page.request.get(`${origin}/api/ai/connections`)).json(),
    ).toHaveLength(0);
    const approval = await page.request.post(`${origin}/api/ai/authorize`, {
      headers: { Origin: origin },
      data: {
        request,
        scopes: ["progress:read", "drafts:write"],
        approve: true,
      },
    });
    const code = new URL((await approval.json()).redirect).searchParams.get(
      "code",
    )!;
    const token = await (
      await page.request.post(`${origin}/oauth/token`, {
        form: {
          grant_type: "authorization_code",
          client_id: request.client_id,
          resource: request.resource,
          redirect_uri: request.redirect_uri,
          code,
          code_verifier: verifier,
        },
      })
    ).json();
    client = await mcpClient(origin, token.access_token);
    const input = {
      operationId: randomUUID(),
      title: "AI 审计日报",
      entries: [{ id: randomUUID(), body: "私人正文不进入操作记录" }],
    };
    await client.callTool({ name: "create_draft", arguments: input });
    await client.callTool({ name: "create_draft", arguments: input });
    await client.callTool({
      name: "create_draft",
      arguments: { ...input, title: "冲突" },
    });
    await page.goto(`${origin}/ai`);
    const history = page.getByRole("region", { name: "AI 操作记录" });
    await expect(
      history.getByText("新建草稿 · 成功", { exact: true }),
    ).toBeVisible();
    await expect(
      history.getByText("新建草稿 · 已处理，返回原结果", { exact: true }),
    ).toBeVisible();
    await expect(
      history.getByText("新建草稿 · 失败", { exact: true }),
    ).toBeVisible();
    await expect(history).not.toContainText("私人正文不进入操作记录");
    await history.getByRole("link", { name: "查看对象" }).first().click();
    await expect(page.getByLabel("日报标题", { exact: true })).toHaveValue(
      "AI 审计日报",
    );
    await page.goto(`${origin}/ai`);
    await page.getByRole("button", { name: "撤销连接", exact: true }).click();
    await expect(page.getByText("已撤销", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重新授权", exact: true }).click();
    const reconnect = page.getByRole("region", { name: "重新授权 Codex" });
    await expect(reconnect).toBeVisible();
    await expect(reconnect.getByLabel("授权命令")).toHaveValue(
      "codex mcp login daily_flow --scopes progress:read,drafts:write",
    );
    await expect(
      reconnect.getByRole("button", { name: "复制授权命令" }),
    ).toBeVisible();
    await reconnect.getByLabel("Codex 连接名称").fill("team_daily");
    await expect(reconnect.getByLabel("授权命令")).toHaveValue(
      "codex mcp login team_daily --scopes progress:read,drafts:write",
    );
    const revoked = await (
      await page.request.get(`${origin}/api/ai/connections`)
    ).json();
    expect(revoked).toHaveLength(1);
    expect(revoked[0].revokedAt).not.toBeNull();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "重新授权", exact: true }),
    ).toBeVisible();
    await page.getByLabel("执行结果").selectOption("failure");
    await expect(
      history.getByText("新建草稿 · 失败", { exact: true }),
    ).toBeVisible();
    await expect(
      history.getByText("新建草稿 · 成功", { exact: true }),
    ).toHaveCount(0);
  } finally {
    await client?.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
