import { expect, test } from "@playwright/test";

test("从本机引导建立团队，再通过邀请加入、管理邀请并重新登录", async ({
  page,
  browser,
}) => {
  await page.goto("/setup#key=browser-test-setup-key");
  await page.getByLabel("团队名称").fill("日序工作室");
  await page.getByLabel("姓名", { exact: true }).fill("林晓");
  await page.getByLabel("邮箱", { exact: true }).fill("lin@example.test");
  await page.getByLabel("密码", { exact: true }).fill("QuietRiver2026!");
  await page.getByRole("button", { name: "创建团队并进入" }).click();
  await expect(
    page.getByRole("heading", { name: "邀请同事，一起开始。" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "生成邀请链接" }).click();
  const joinUrl = await page.getByLabel("新邀请链接").inputValue();
  const secondContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const second = await secondContext.newPage();
  await second.goto(joinUrl);
  await expect(
    second.getByRole("heading", { name: "加入日序工作室" }),
  ).toBeVisible();
  await second.getByLabel("姓名", { exact: true }).fill("周宁");
  await second.getByLabel("邮箱", { exact: true }).fill("zhou@example.test");
  await second.getByLabel("密码", { exact: true }).fill("SecondMember2026!");
  await second.getByRole("button", { name: "加入团队" }).click();
  await expect(
    second.getByRole("heading", { name: "邀请同事，一起开始。" }),
  ).toBeVisible();
  await expect(second.getByText("周宁", { exact: true })).toBeVisible();
  await second.reload();
  await expect(second.getByText("周宁", { exact: true })).toBeVisible();
  await second.getByRole("button", { name: "生成邀请链接" }).click();
  await expect(second.getByLabel("新邀请链接")).toBeVisible();
  await second.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(second.getByText("已撤销", { exact: true })).toBeVisible();
  await expect(second.getByLabel("新邀请链接")).toHaveCount(0);
  await second.screenshot({
    path: "test-results/membership-mobile.png",
    fullPage: true,
  });
  expect(
    await second.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await second.getByRole("button", { name: "我的账号" }).click();
  await expect(
    second.getByText("zhou@example.test", { exact: true }),
  ).toBeVisible();
  await second.getByRole("button", { name: "退出登录" }).click();
  await second.getByLabel("邮箱", { exact: true }).fill("zhou@example.test");
  await second.getByLabel("密码", { exact: true }).fill("SecondMember2026!");
  await second.getByRole("button", { name: "登录", exact: true }).click();
  await expect(second.getByText("周宁", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("已接受", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/membership-desktop.png",
    fullPage: true,
  });
  await secondContext.close();
});
