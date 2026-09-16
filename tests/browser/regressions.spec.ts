import { test, expect, type Page } from "@playwright/test";
const origin = "http://127.0.0.1:4311";
async function login(page: Page) {
  const status = await (await page.request.get("/api/setup/status")).json();
  const credentials = {
    name: "林晓",
    email: "lin@example.test",
    password: "QuietRiver2026!",
    teamName: "日序工作室",
    setupKey: "browser-test-setup-key",
  };
  await page.request.post(status.needsSetup ? "/api/setup" : "/api/login", {
    headers: { Origin: origin },
    data: credentials,
  });
  await page.goto("/diaries");
}
test("任务定义编辑不会串到另一任务", async ({ page }) => {
  await login(page);
  const project = await (
    await page.request.post("/api/projects", {
      headers: { Origin: origin },
      data: { name: "任务切换验证", description: "" },
    })
  ).json();
  for (const name of ["任务甲", "任务乙"])
    await page.request.post(`/api/projects/${project.id}/tasks`, {
      headers: { Origin: origin },
      data: { name, description: `${name}原始说明` },
    });
  await page.getByRole("button", { name: "项目与任务", exact: true }).click();
  await page.getByRole("button", { name: /任务切换验证/ }).click();
  await page.getByRole("button", { name: /任务甲 待开始/ }).click();
  await page.getByRole("button", { name: "编辑任务定义" }).click();
  await page.getByLabel("任务名称", { exact: true }).fill("甲的未保存修改");
  await page.getByRole("button", { name: /任务乙 待开始/ }).click();
  await expect(page.getByLabel("任务名称", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("任务详情")).toContainText("任务乙原始说明");
});
test("失败附件需明确处理后才可提交，正文草稿保留", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "＋ 新建日报", exact: true }).click();
  await page.getByLabel("日报标题", { exact: true }).fill("附件失败处理");
  await page.getByLabel("工作 1", { exact: true }).fill("正文不能丢失");
  await page.locator(".attachments summary").click();
  await page
    .getByLabel("工作 1 添加附件", { exact: true })
    .setInputFiles({
      name: "不支持.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("file"),
    });
  await expect(page.getByRole("alert")).toContainText("不支持");
  await expect(
    page.getByRole("button", { name: "提交日报", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "放弃此附件", exact: true }).click();
  await page.getByRole("button", { name: "提交日报", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("日报已提交");
  await page.getByRole("button", { name: "团队日报", exact: true }).click();
  await expect(
    page.locator(".records").getByText("正文不能丢失", { exact: true }),
  ).toBeVisible();
});
