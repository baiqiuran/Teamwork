import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const origin = "http://127.0.0.1:4311";

async function seedReports(page: Page) {
  const status = await (await page.request.get("/api/setup/status")).json();
  const auth = await page.request.post(
    status.needsSetup ? "/api/setup" : "/api/login",
    {
      headers: { Origin: origin },
      data: {
        name: "林晓",
        email: "lin@example.test",
        password: "QuietRiver2026!",
        teamName: "日序工作室",
        setupKey: "browser-test-setup-key",
      },
    },
  );
  expect(auth.ok()).toBeTruthy();
  const project = await (
    await page.request.post("/api/projects", {
      headers: { Origin: origin },
      data: { name: "秋季发布", description: "桌面布局验证" },
    })
  ).json();
  const reports = [
    {
      title: "本周交付整理",
      body: "已整理本周交付清单。\n剩余事项已同步到项目，明天继续跟进。",
    },
    {
      title: "视觉规范与组件整理",
      body: "完成了主要页面的视觉走查，统一按钮、间距和文本层级。\n\n今日完成\n· 整理输入框和筛选器的使用规则\n· 补齐空状态与错误提示\n· 复核日报阅读区的可读性\n\n待跟进\n长标题及多附件情况下的排版，还需要结合实际内容继续验证。",
    },
    {
      title: "公开分享验证",
      body: "验证日报、项目、任务三类公开链接。\n\n关闭链接后，页面及附件均不可访问。\n历史日报仍保留提交时的任务状态。",
    },
    {
      title: "接口联调与问题记录",
      body: "完成成员邀请与登录流程的联调。\n\n核对内容\n1. 邀请过期后提示重新申请\n2. 重复使用邀请时不创建新成员\n3. 退出后会话失效\n4. 未提交内容不会出现在团队日报\n\n联调中发现的文案问题已记录，待下一轮统一处理。",
    },
    {
      title: "项目资料更新",
      body: "已补充项目背景和交付说明，相关任务均已关联。",
    },
    {
      title: "日报阅读体验调整",
      body: "把筛选条件集中到一行，让工作内容尽早进入视野。\n\n日报按内容高度排列，较短的记录不会留下整行空白。\n\n本轮重点\n· 保留每份日报的完整条目\n· 日期、成员和项目一起筛选\n· 较长的正文和标签正常换行\n\n下一步\n结合团队实际填写习惯，继续观察阅读效率。",
    },
    {
      title: "发布前检查",
      body: "主流程验证完成。\n备份与恢复步骤已整理，等待最后复核。",
    },
  ];
  for (const report of reports) {
    const draft = await (
      await page.request.post("/api/diaries", {
        headers: { Origin: origin },
        data: {
          title: report.title,
          entries: [
            { id: randomUUID(), body: report.body, projectId: project.id },
          ],
        },
      })
    ).json();
    const submitted = await page.request.post(
      `/api/diaries/${draft.id}/submit`,
      {
        headers: { Origin: origin },
        data: { version: draft.version, requestId: randomUUID() },
      },
    );
    expect(submitted.ok()).toBeTruthy();
  }
  await page.goto("/diaries");
  await page.getByRole("button", { name: "团队日报", exact: true }).click();
  await page
    .getByRole("combobox", { name: "项目", exact: true })
    .selectOption(project.id);
  await page.getByRole("button", { name: "查看日报", exact: true }).click();
  await expect(page.locator(".record-card")).toHaveCount(reports.length);
  return project;
}

test("桌面日报筛选横向对齐，长短卡片多列排列且筛选后重新布局", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1640, height: 1000 });
  await seedReports(page);
  const from = await page.getByLabel("开始日期", { exact: true }).inputValue();
  const to = await page.getByLabel("结束日期", { exact: true }).inputValue();
  await page.screenshot({
    path: "test-results/team-layout-before-or-after.png",
    fullPage: true,
  });
  const controls = page.locator(
    ".filters input, .filters select, .filters button",
  );
  const tops = await controls.evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().top),
  );
  expect(
    Math.max(...tops) - Math.min(...tops),
    "筛选控件应在一行中对齐",
  ).toBeLessThan(4);

  for (const width of [1640, 1280, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(async () =>
        page.locator(".record-card").evaluateAll((cards) => {
          const bounds = cards.map((card) => card.getBoundingClientRect());
          return new Set(bounds.map((box) => Math.round(box.x))).size;
        }),
      )
      .toBeGreaterThanOrEqual(2);
    const boxes = await page.locator(".record-card").evaluateAll((cards) =>
      cards.map((card) => {
        const box = card.getBoundingClientRect();
        return {
          x: box.x,
          y: box.y,
          right: box.right,
          bottom: box.bottom,
          height: box.height,
        };
      }),
    );
    expect(boxes[0].y, "首张日报应位于首屏上部").toBeLessThan(420);
    expect(
      new Set(boxes.map((box) => Math.round(box.height))).size,
    ).toBeGreaterThan(2);
    const xPositions = [...new Set(boxes.map((box) => Math.round(box.x)))];
    const secondCards = xPositions
      .map((x) => boxes.filter((box) => Math.round(box.x) === x)[1])
      .filter(Boolean);
    expect(
      new Set(secondCards.map((box) => Math.round(box.y))).size,
      "后续卡片应随上方内容错落排列",
    ).toBeGreaterThan(1);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i],
          b = boxes[j];
        const overlap =
          a.x < b.right - 1 &&
          a.right > b.x + 1 &&
          a.y < b.bottom - 1 &&
          a.bottom > b.y + 1;
        expect(overlap, "日报卡片不能重叠").toBeFalsy();
      }
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: `test-results/team-layout-${width}.png`,
      fullPage: true,
    });
  }

  await page.getByLabel("开始日期", { exact: true }).fill("2000-01-01");
  await page.getByLabel("结束日期", { exact: true }).fill("2000-01-02");
  await page.getByRole("button", { name: "查看日报", exact: true }).click();
  await expect(page.locator(".record-card")).toHaveCount(0);
  await expect(
    page.getByText("所选范围内暂无已提交进展。", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("开始日期", { exact: true }).fill(from);
  await page.getByLabel("结束日期", { exact: true }).fill(to);
  await page.getByRole("button", { name: "查看日报", exact: true }).click();
  await expect(page.locator(".record-card")).toHaveCount(7);
  await expect
    .poll(async () =>
      page.locator(".record-card").evaluateAll((cards) => {
        const boxes = cards.map((card) => card.getBoundingClientRect());
        return boxes.every((a, i) =>
          boxes
            .slice(i + 1)
            .every(
              (b) =>
                a.right <= b.left + 1 ||
                b.right <= a.left + 1 ||
                a.bottom <= b.top + 1 ||
                b.bottom <= a.top + 1,
            ),
        );
      }),
    )
    .toBeTruthy();
});
