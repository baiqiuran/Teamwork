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
  await second.getByLabel("密码", { exact: true }).press("Enter");
  await expect(second.getByText("周宁", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("已接受", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/membership-desktop.png",
    fullPage: true,
  });
  await secondContext.close();
});

test("无效邀请明确显示原因，不能继续注册", async ({ page }) => {
  await page.goto("/join#invite=invalid-invitation");
  await expect(page.getByRole("alert")).toContainText("邀请无效");
  await expect(
    page.getByRole("button", { name: "加入团队", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "已有账号？前往登录 →" }),
  ).toBeVisible();
});

test("键盘编写多条私人草稿，刷新重开和窄屏切换", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill("lin@example.test");
  await page.getByLabel("密码", { exact: true }).fill("QuietRiver2026!");
  await page.getByLabel("密码", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "我的日报", exact: true }).click();
  await page.getByRole("button", { name: "＋ 新建日报", exact: true }).click();
  await page.getByLabel("日报标题", { exact: true }).fill("接口与文档");
  await page
    .getByLabel("工作 1", { exact: true })
    .fill("完成接口\n\n- 验证权限\n- 补充文档");
  await page
    .getByRole("button", { name: "＋ 新增一条工作", exact: true })
    .press("Enter");
  await page.getByLabel("工作 2", { exact: true }).fill("参加例会");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("草稿已保存");
  await page.reload();
  await page.getByRole("button", { name: /接口与文档/ }).click();
  await expect(page.getByLabel("工作 1", { exact: true })).toHaveValue(
    "完成接口\n\n- 验证权限\n- 补充文档",
  );
  await expect(page.getByLabel("工作 2", { exact: true })).toHaveValue(
    "参加例会",
  );
  await page.screenshot({
    path: "test-results/diary-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "＋ 新建日报", exact: true }).click();
  await page.getByRole("button", { name: /接口与文档/ }).click();
  await expect(page.getByLabel("工作 2", { exact: true })).toHaveValue(
    "参加例会",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/diary-mobile.png",
    fullPage: true,
  });
});

test("提交后团队读取原版本，保存补充后仍保持原文，再提交更新", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill("lin@example.test");
  await page.getByLabel("密码", { exact: true }).fill("QuietRiver2026!");
  await page.getByLabel("密码", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "我的日报", exact: true }).click();
  await page.getByRole("button", { name: /接口与文档/ }).click();
  await page.getByRole("button", { name: "提交日报", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("日报已提交");
  await page.getByLabel("工作 2", { exact: true }).fill("未重提的例会补充");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page.getByRole("button", { name: "团队日报", exact: true }).click();
  await expect(
    page.locator(".records").getByText("参加例会", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".records").getByText("未重提的例会补充", { exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "我的日报", exact: true }).click();
  await page.getByRole("button", { name: /接口与文档/ }).click();
  await page.getByRole("button", { name: "重新提交", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("日报已提交");
  await page.getByRole("button", { name: "团队日报", exact: true }).click();
  await expect(
    page.locator(".records").getByText("未重提的例会补充", { exact: true }),
  ).toBeVisible();
});

test("项目任务关联、附件、冲突选择和三类公开页，可归档撤销访问", async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const origin = "http://127.0.0.1:4311";
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill("lin@example.test");
  await page.getByLabel("密码", { exact: true }).fill("QuietRiver2026!");
  await page.getByLabel("密码", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "项目与任务", exact: true }).click();
  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("移动端上线");
  await page.getByLabel("项目说明", { exact: true }).fill("完成移动端首版");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await page.getByRole("button", { name: "＋ 新建任务" }).click();
  await page.getByLabel("任务名称", { exact: true }).fill("登录联调");
  await page.getByLabel("任务原始说明", { exact: true }).fill("对接真实登录");
  await page.getByRole("button", { name: "保存任务", exact: true }).click();
  await expect(page.getByLabel("任务详情")).toContainText("登录联调");
  const projects = await (await page.request.get("/api/projects")).json();
  const project = projects.find(
    (p: { name: string }) => p.name === "移动端上线",
  );
  const task = (
    await (await page.request.get(`/api/projects/${project.id}/tasks`)).json()
  )[0];
  await page.getByRole("button", { name: "我的日报", exact: true }).click();
  await page.getByRole("button", { name: "＋ 新建日报", exact: true }).click();
  await page.getByLabel("日报标题", { exact: true }).fill("移动端交付记录");
  await page
    .getByLabel("工作 1", { exact: true })
    .fill("登录已联调\n- 已完成验证");
  await page.getByLabel("工作 1", { exact: true }).press("Shift+Digit2");
  await page
    .getByLabel("工作 1 关联项目", { exact: true })
    .selectOption(project.id);
  await page.getByText("关联任务或更新状态（选填）", { exact: true }).click();
  await page.getByLabel("工作 1 任务", { exact: true }).selectOption(task.id);
  await page
    .getByLabel("工作 1 更新状态", { exact: true })
    .selectOption("done");
  await page
    .getByLabel("工作 1 添加附件", { exact: true })
    .setInputFiles({
      name: "联调说明.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("联调附件"),
    });
  await expect(page.getByRole("status")).toContainText("附件已保存");
  const otherContext = await browser.newContext();
  await otherContext.request.post(`${origin}/api/login`, {
    headers: { Origin: origin },
    data: { email: "zhou@example.test", password: "SecondMember2026!" },
  });
  const conflicting = await (
    await otherContext.request.post(`${origin}/api/diaries`, {
      headers: { Origin: origin },
      data: {
        title: "同事更新",
        entries: [
          {
            id: crypto.randomUUID(),
            body: "开始验证",
            projectId: project.id,
            taskId: task.id,
            statusChange: { status: "in-progress", expectedVersion: 1 },
          },
        ],
      },
    })
  ).json();
  await otherContext.request.post(
    `${origin}/api/diaries/${conflicting.id}/submit`,
    {
      headers: { Origin: origin },
      data: { version: 1, requestId: crypto.randomUUID() },
    },
  );
  await page.getByRole("button", { name: "提交日报", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "任务有新的状态，请确认本次提交" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "执行我选择的状态" }).click();
  await page.getByRole("button", { name: "提交日报", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("日报已提交");
  await page.getByRole("button", { name: "团队日报", exact: true }).click();
  await page
    .getByRole("combobox", { name: "成员", exact: true })
    .selectOption({ label: "林晓" });
  await page
    .getByRole("combobox", { name: "项目", exact: true })
    .selectOption(project.id);
  await page.getByRole("button", { name: "查看日报" }).click();
  await expect(
    page.locator(".records").getByRole("heading", { name: "移动端交付记录" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "公开分享", exact: true }).click();
  const visitor = await browser.newContext();
  const publicPage = await visitor.newPage();
  const paths: string[] = [];
  for (const type of ["diary", "project", "task"]) {
    await page
      .getByRole("combobox", { name: "分享内容", exact: true })
      .selectOption(type);
    if (type !== "diary")
      await page
        .getByRole("combobox", { name: "选择项目", exact: true })
        .selectOption(project.id);
    if (type === "task")
      await page
        .getByRole("combobox", { name: "选择任务", exact: true })
        .selectOption(task.id);
    await page
      .getByRole("button", { name: "生成公开链接", exact: true })
      .click();
    await expect(page.getByLabel("新公开链接")).toBeVisible();
    await expect(page.locator(".share-row")).toHaveCount(paths.length + 1);
    const url = await page.getByLabel("新公开链接").inputValue();
    paths.push(url);
    await publicPage.goto(url);
    await publicPage
      .getByRole("button", { name: "进展日报", exact: true })
      .click();
    await expect(
      publicPage.getByText("登录已联调\n- 已完成验证", { exact: true }),
    ).toBeVisible();
    await expect(
      publicPage.getByRole("link", { name: "↓ 联调说明.txt" }),
    ).toBeVisible();
    await publicPage
      .getByRole("button", { name: "任务列表", exact: true })
      .click();
    await expect(publicPage.getByText("已完成", { exact: true })).toBeVisible();
  }
  await publicPage.setViewportSize({ width: 390, height: 844 });
  await publicPage
    .getByRole("button", { name: "进展日报", exact: true })
    .click();
  expect(
    await publicPage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await publicPage.screenshot({
    path: "test-results/public-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "项目与任务", exact: true }).click();
  await page.getByRole("button", { name: /移动端上线.*林晓/ }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "归档项目", exact: true }).click();
  await expect(
    page.getByText(
      "项目已归档，保留历史，停止新增进展。恢复后旧公开链接仍保持关闭。",
    ),
  ).toBeVisible();
  await publicPage.goto(paths[1]);
  await expect(publicPage.getByRole("alert")).toContainText("无效或已关闭");
  await publicPage.goto(paths[0]);
  await publicPage
    .getByRole("button", { name: "进展日报", exact: true })
    .click();
  await expect(
    publicPage.getByText("登录已联调\n- 已完成验证", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "公开分享", exact: true }).click();
  await page.getByRole("button", { name: "关闭链接", exact: true }).click();
  await publicPage.reload();
  await expect(publicPage.getByRole("alert")).toContainText("无效或已关闭");
  await visitor.close();
  await otherContext.close();
});
