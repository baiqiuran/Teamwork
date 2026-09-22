import { expect, test as base, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../application.ts";
import type {
  Diary,
  Identity,
  Project,
  PublishedDiary,
  Task,
} from "../../src/shared/contracts.ts";

const initialTime = Date.parse("2026-09-21T03:00:00Z");
const originalBytes = Buffer.from("首版附件\n权限验证 2026\n");
const revisedBytes = Buffer.from("尚未再次提交的附件\n仅作者可见\n");
const test = base.extend<{
  service: {
    origin: string;
    files: [string, string];
    setTime: (time: number) => void;
  };
}>({
  service: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "daily-team-diaries-"));
    const files: [string, string] = [
      join(directory, "首版.txt"),
      join(directory, "补充.txt"),
    ];
    await writeFile(files[0], originalBytes);
    await writeFile(files[1], revisedBytes);
    let time = initialTime;
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
        files,
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

// Only exact, deliberately exercised failures are allowed, once each.
function observeErrors(page: Page) {
  const errors: string[] = [];
  const expected = new Map<string, number>();
  const seen = new Map<string, number>();
  const consoleSeen = new Map<string, number>();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) =>
    errors.push(`${request.failure()?.errorText} ${request.url()}`),
  );
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const key = `${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if ((seen.get(key) ?? 0) > (expected.get(key) ?? 0)) errors.push(key);
  });
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    const status = message
      .text()
      .match(
        /^Failed to load resource: the server responded with a status of (\d{3})\b/,
      )?.[1];
    const path = new URL(message.location().url || page.url()).pathname;
    const key = [...expected.keys()].find((key) =>
      key.endsWith(` ${path} ${status}`),
    );
    if (!key) errors.push(message.text());
    else {
      consoleSeen.set(key, (consoleSeen.get(key) ?? 0) + 1);
      if (consoleSeen.get(key)! > expected.get(key)!)
        errors.push(message.text());
    }
  });
  return {
    allow: (method: string, path: string, status: number, count = 1) =>
      expected.set(`${method} /api${path} ${status}`, count),
    check: () => {
      expect.soft(errors).toEqual([]);
      for (const [key, count] of expected)
        expect.soft(seen.get(key), key).toBe(count);
    },
  };
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    page.url(),
  ).toBe(true);
}

async function seed<T>(
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
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function createTeam(
  page: Page,
  origin: string,
  prefix: string,
): Promise<Identity> {
  return seed(page, origin, "/setup", {
    teamName: `${prefix}团队`,
    name: `${prefix}作者`,
    email: `${prefix === "青山" ? "green" : "blue"}@example.test`,
    password: "TeamDiaries2026!",
  });
}

async function createWork(page: Page, origin: string, prefix: string) {
  const project = await seed<Project>(page, origin, "/projects", {
    name: `${prefix}项目`,
    description: "项目说明",
  });
  const task = await seed<Task>(page, origin, `/projects/${project.id}/tasks`, {
    name: `${prefix}任务`,
    description: "任务说明",
  });
  return { project, task };
}

async function post<T>(
  page: Page,
  path: string,
  action: () => Promise<unknown>,
  status = 200,
): Promise<T> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api${path}` &&
        response.request().method() === "POST",
    ),
    action(),
  ]);
  expect(response.status(), path).toBe(status);
  return response.json();
}

async function read<T>(page: Page, origin: string, path: string): Promise<T> {
  const response = await page.request.get(`${origin}/api${path}`);
  expect(response.status(), path).toBe(200);
  return response.json();
}

async function denied(
  page: Page,
  origin: string,
  path: string,
  secrets: string[],
) {
  const response = await page.request.get(`${origin}/api${path}`);
  expect(response.status(), path).toBe(404);
  const body = await response.json();
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error).toEqual(expect.any(String));
  for (const secret of secrets)
    expect(JSON.stringify(body)).not.toContain(secret);
}

async function bytes(page: Page, origin: string, id: string, expected: Buffer) {
  const response = await page.request.get(`${origin}/api/attachments/${id}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain(
    "application/octet-stream",
  );
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.body()).toEqual(expected);
}

async function draft(page: Page, origin: string, title: string, body: string) {
  await page.goto(`${origin}/diaries`);
  const diary = await post<Diary>(
    page,
    "/diaries",
    () =>
      page.getByRole("button", { name: "＋ 新建日报", exact: true }).click(),
    201,
  );
  expect(diary).toMatchObject({
    diaryDate: null,
    published: null,
    editable: true,
  });
  await expect(page.getByLabel("日报标题", { exact: true })).toHaveAttribute(
    "placeholder",
    "输入日报标题（选填）",
  );
  await page.getByLabel("日报标题", { exact: true }).fill(title);
  await page.getByLabel("工作 1", { exact: true }).fill(body);
  return diary;
}

async function associate(
  page: Page,
  own: Awaited<ReturnType<typeof createWork>>,
  foreign: Awaited<ReturnType<typeof createWork>>,
) {
  await page.getByRole("button", { name: "@ 关联项目", exact: true }).click();
  const projects = page.getByLabel("工作 1 关联项目", { exact: true });
  await expect(projects.locator("option")).toContainText([
    "不关联项目",
    own.project.name,
  ]);
  await expect(projects).not.toContainText(foreign.project.name);
  await projects.selectOption(own.project.id);
  await page.getByText("关联任务或更新状态（选填）", { exact: true }).click();
  const tasks = page.getByLabel("工作 1 任务", { exact: true });
  await expect(tasks).toContainText(own.task.name);
  await expect(tasks).not.toContainText(foreign.task.name);
  await tasks.selectOption(own.task.id);
  await page
    .getByLabel("工作 1 更新状态", { exact: true })
    .selectOption("done");
  await noOverflow(page);
}

async function upload(page: Page, diary: Diary, file: string) {
  const attachments = page.locator(".attachments details");
  if (!(await attachments.getAttribute("open"))) {
    // The boolean open attribute has an empty value when present.
    if (
      !(await attachments.evaluate(
        (element) => (element as HTMLDetailsElement).open,
      ))
    )
      await attachments.locator("summary").click();
  }
  const updated = await post<Diary>(
    page,
    `/diaries/${diary.id}/entries/${diary.draft.entries[0].id}/attachments`,
    () =>
      page.getByLabel("工作 1 添加附件", { exact: true }).setInputFiles(file),
    201,
  );
  await expect(page.getByRole("status")).toHaveText(
    "附件已保存到草稿，提交后团队才可见。",
  );
  await noOverflow(page);
  return updated;
}

async function submit(page: Page, diary: Diary) {
  const result = await post<Diary>(page, `/diaries/${diary.id}/submit`, () =>
    page
      .getByRole("button", {
        name: diary.diaryDate ? "重新提交" : "提交日报",
        exact: true,
      })
      .click(),
  );
  await expect(page.getByRole("status")).toHaveText(
    "日报已提交，团队可以查看。",
  );
  return result;
}

async function teamQuery(page: Page, action: () => Promise<unknown>) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/team-diaries",
    ),
    action(),
  ]);
  expect(response.status()).toBe(200);
  await expect(
    page.getByRole("button", { name: "查看日报", exact: true }),
  ).toBeEnabled();
  await noOverflow(page);
  return {
    records: (await response.json()) as PublishedDiary[],
    query: new URL(response.url()).searchParams,
  };
}

async function filter(page: Page) {
  return teamQuery(page, () =>
    page.getByRole("button", { name: "查看日报", exact: true }).click(),
  );
}

async function visibleRecord(page: Page, diary: Diary) {
  const records = page.locator(".records");
  await expect(
    records.getByRole("heading", { name: diary.published!.title, exact: true }),
  ).toBeVisible();
  await expect(
    records.getByText(diary.published!.entries[0].body, { exact: true }),
  ).toBeVisible();
}

test("日报入口直接说明保存草稿与提交的区别", async ({ page, service }) => {
  const monitor = observeErrors(page);
  try {
    await createTeam(page, service.origin, "青山");
    await page.goto(`${service.origin}/diaries`);
    await expect(
      page.getByRole("heading", { name: "我的日报", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("保存草稿仅自己可见，提交后团队可见。", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "新建或选择日报", exact: true }),
    ).toBeVisible();
    await noOverflow(page);
  } finally {
    monitor.check();
  }
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`两个团队的日报关联、附件、筛选、重新提交与历史只读 ${viewport.width}`, async ({
    page,
    browser,
    service,
  }) => {
    test.setTimeout(180_000);
    const { origin, files } = service;
    await page.setViewportSize(viewport);
    const foreignContext = await browser.newContext({ viewport });
    const readerContext = await browser.newContext({ viewport });
    const foreign = await foreignContext.newPage();
    const reader = await readerContext.newPage();
    const monitors = [page, foreign, reader].map(observeErrors);
    try {
      for (const current of [page, foreign, reader])
        await current.clock.setFixedTime(initialTime);
      const owner = await createTeam(page, origin, "青山");
      const other = await createTeam(foreign, origin, "蓝海");
      expect(owner.team.id).not.toBe(other.team.id);
      const invitation = await seed<{ token: string }>(
        page,
        origin,
        "/invitations",
        {},
      );
      const teammate = await seed<Identity>(reader, origin, "/join", {
        token: invitation.token,
        name: "青山读者",
        email: "reader@example.test",
        password: "TeamDiaries2026!",
      });
      expect(teammate.team.id).toBe(owner.team.id);
      const ownWork = await createWork(page, origin, "青山");
      const otherWork = await createWork(foreign, origin, "蓝海");
      const emptyProject = await seed<Project>(page, origin, "/projects", {
        name: "青山待办项目",
        description: "暂无日报",
      });
      let own = await draft(
        page,
        origin,
        "青山日报",
        "青山首次提交的工作\n- 验证附件",
      );
      await associate(page, ownWork, otherWork);
      own = await post<Diary>(page, `/diaries/${own.id}/save`, () =>
        page.getByRole("button", { name: "保存草稿", exact: true }).click(),
      );
      expect(own.draft.entries[0]).toMatchObject({
        projectId: ownWork.project.id,
        taskId: ownWork.task.id,
        statusChange: { status: "done" },
      });
      await expect(page.getByRole("status")).toHaveText(
        "草稿已保存，仅你可见。",
      );
      await page.reload();
      await page.getByRole("button", { name: /青山日报/ }).click();
      await expect(page.getByLabel("工作 1", { exact: true })).toHaveValue(
        "青山首次提交的工作\n- 验证附件",
      );
      own = await upload(page, own, files[0]);
      const original = own.draft.entries[0].attachments![0];
      await bytes(page, origin, original.id, originalBytes);
      let otherDiary = await draft(
        foreign,
        origin,
        "蓝海日报",
        "蓝海内部工作内容",
      );
      await associate(foreign, otherWork, ownWork);
      otherDiary = await upload(foreign, otherDiary, files[0]);
      const otherFile = otherDiary.draft.entries[0].attachments![0];
      for (const visitor of [reader, foreign]) {
        await denied(visitor, origin, `/diaries/${own.id}`, [
          own.draft.title,
          own.draft.entries[0].body,
        ]);
        await denied(visitor, origin, `/attachments/${original.id}`, [
          original.name,
          originalBytes.toString(),
        ]);
      }
      const empty = await teamQuery(reader, () =>
        reader.goto(`${origin}/team`),
      );
      expect(empty.records).toEqual([]);
      await expect(
        reader.getByText("按成员、项目和日期查看本团队已提交的日报。", {
          exact: true,
        }),
      ).toBeVisible();
      own = await submit(page, own);
      otherDiary = await submit(foreign, otherDiary);
      expect(own.diaryDate).toBe("2026-09-21");
      expect(own.published!.entries[0]).toMatchObject({
        projectName: ownWork.project.name,
        taskName: ownWork.task.name,
        taskStatus: "done",
        attachments: [original],
      });
      expect(
        await read<Task>(page, origin, `/tasks/${ownWork.task.id}`),
      ).toMatchObject({ status: "done", version: 2 });

      for (const [
        current,
        diary,
        identity,
        foreignDiary,
        foreignIdentity,
        work,
      ] of [
        [reader, own, owner, otherDiary, other, ownWork],
        [foreign, otherDiary, other, own, owner, otherWork],
      ] as const) {
        if (current === foreign)
          await teamQuery(current, () =>
            current
              .getByRole("button", { name: "团队日报", exact: true })
              .click(),
          );
        const result = await filter(current);
        expect(result.records).toMatchObject([
          {
            id: diary.id,
            author: { id: identity.member.id },
            published: diary.published,
          },
        ]);
        expect(result.records).toHaveLength(1);
        await visibleRecord(current, diary);
        const filters = current.getByRole("form", { name: "筛选团队日报" });
        await expect(
          filters.getByRole("combobox", { name: "成员", exact: true }),
        ).toContainText(identity.member.name);
        await expect(
          filters.getByRole("combobox", { name: "项目", exact: true }),
        ).toContainText(work.project.name);
        for (const text of [
          foreignDiary.published!.title,
          foreignDiary.published!.entries[0].body,
          foreignIdentity.member.name,
          foreignIdentity.team.name,
        ]) {
          await expect(current.getByText(text, { exact: true })).toHaveCount(0);
          expect(JSON.stringify(result.records)).not.toContain(text);
        }
        await current
          .getByRole("combobox", { name: "成员", exact: true })
          .selectOption(identity.member.id);
        await current
          .getByRole("combobox", { name: "项目", exact: true })
          .selectOption(work.project.id);
        const selected = await filter(current);
        expect(selected.query.get("memberId")).toBe(identity.member.id);
        expect(selected.query.get("projectId")).toBe(work.project.id);
        expect(selected.records).toHaveLength(1);
      }
      await expect(
        reader
          .getByRole("combobox", { name: "成员", exact: true })
          .locator("option"),
      ).toHaveText(["全部成员", "青山作者", "青山读者"]);
      await reader
        .getByRole("combobox", { name: "成员", exact: true })
        .selectOption(teammate.member.id);
      expect((await filter(reader)).records).toEqual([]);
      await reader
        .getByRole("combobox", { name: "成员", exact: true })
        .selectOption(owner.member.id);
      await reader
        .getByRole("combobox", { name: "项目", exact: true })
        .selectOption(emptyProject.id);
      expect((await filter(reader)).records).toEqual([]);
      await reader
        .getByRole("combobox", { name: "项目", exact: true })
        .selectOption(ownWork.project.id);
      await reader.getByLabel("开始日期", { exact: true }).fill("2026-09-20");
      await reader.getByLabel("结束日期", { exact: true }).fill("2026-09-20");
      const previousDay = await filter(reader);
      expect(previousDay.query.get("from")).toBe("2026-09-20");
      expect(previousDay.query.get("to")).toBe("2026-09-20");
      expect(previousDay.records).toEqual([]);
      await reader.getByLabel("开始日期", { exact: true }).fill("2026-09-21");
      await reader.getByLabel("结束日期", { exact: true }).fill("2026-09-21");
      await filter(reader);
      await visibleRecord(reader, own);
      const link = reader.getByRole("link", {
        name: "↓ 首版.txt",
        exact: true,
      });
      await expect(link).toHaveAttribute(
        "href",
        `/api/attachments/${original.id}`,
      );
      await bytes(reader, origin, original.id, originalBytes);
      await denied(foreign, origin, `/attachments/${original.id}`, [
        original.name,
        originalBytes.toString(),
      ]);
      await denied(page, origin, `/attachments/${otherFile.id}`, [
        otherFile.name,
        originalBytes.toString(),
      ]);
      await denied(reader, origin, `/team-diaries/${otherDiary.id}`, [
        otherDiary.published!.title,
        "蓝海内部工作内容",
      ]);

      await page
        .getByLabel("工作 1", { exact: true })
        .fill("青山尚未重新提交的修改");
      own = await post<Diary>(page, `/diaries/${own.id}/save`, () =>
        page.getByRole("button", { name: "保存草稿", exact: true }).click(),
      );
      const publishedBefore = own.published;
      own = await upload(page, own, files[1]);
      const revised = own.draft.entries[0].attachments![1];
      expect(own.published).toEqual(publishedBefore);
      await bytes(page, origin, revised.id, revisedBytes);
      expect((await filter(reader)).records[0].published).toEqual(
        publishedBefore,
      );
      await visibleRecord(reader, own);
      await expect(reader.locator(".records")).not.toContainText(
        "青山尚未重新提交的修改",
      );
      await expect(
        reader.getByRole("link", { name: "↓ 补充.txt", exact: true }),
      ).toHaveCount(0);
      expect(
        (await read<PublishedDiary>(reader, origin, `/team-diaries/${own.id}`))
          .published,
      ).toEqual(publishedBefore);
      await denied(reader, origin, `/attachments/${revised.id}`, [
        revised.name,
        revisedBytes.toString(),
      ]);
      await bytes(reader, origin, original.id, originalBytes);
      own = await submit(page, own);
      expect(own.diaryDate).toBe("2026-09-21");
      expect((await filter(reader)).records[0].published).toEqual(
        own.published,
      );
      await visibleRecord(reader, own);
      await expect(
        reader.getByRole("link", { name: "↓ 补充.txt", exact: true }),
      ).toHaveAttribute("href", `/api/attachments/${revised.id}`);
      await bytes(reader, origin, revised.id, revisedBytes);
      await denied(foreign, origin, `/attachments/${revised.id}`, [
        revised.name,
        revisedBytes.toString(),
      ]);

      await page
        .getByLabel("工作 1", { exact: true })
        .fill("当天未再次提交的最后修改");
      own = await post<Diary>(page, `/diaries/${own.id}/save`, () =>
        page.getByRole("button", { name: "保存草稿", exact: true }).click(),
      );
      service.setTime(Date.parse("2026-09-21T16:00:00Z"));
      const refreshed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/diaries/${own.id}`,
      );
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      expect(await (await refreshed).json()).toMatchObject({
        editable: false,
        diaryDate: "2026-09-21",
      });
      await expect(
        page.getByText(
          "只能在首次提交当天修改日报。未再次提交的修改仍仅你可见。",
          { exact: true },
        ),
      ).toBeVisible();
      for (const name of ["保存草稿", "重新提交", "删除日报"])
        await expect(
          page.getByRole("button", { name, exact: true }),
        ).toBeDisabled();
      await expect(page.getByLabel("工作 1", { exact: true })).toBeDisabled();
      await expect(page.getByLabel("工作 1", { exact: true })).toHaveValue(
        "当天未再次提交的最后修改",
      );
      expect((await filter(reader)).records[0].published).toEqual(
        own.published,
      );
      await expect(reader.locator(".records")).not.toContainText(
        "当天未再次提交的最后修改",
      );
      await noOverflow(page);
    } finally {
      for (const monitor of monitors) monitor.check();
      await readerContext.close();
      await foreignContext.close();
    }
  });
}

test("附件上传失败可重试且不丢正文，会话失效后不伪造保存结果", async ({
  page,
  service,
}) => {
  test.setTimeout(180_000);
  const { origin, files } = service;
  const monitor = observeErrors(page);
  let diary!: Diary;
  try {
    await page.clock.setFixedTime(initialTime);
    const identity = await createTeam(page, origin, "青山");
    await page.setViewportSize({ width: 1440, height: 1000 });
    const created = await draft(page, origin, "重试与失效", "首次保存的正文");
    await page.locator(".attachments summary").click();
    await page.route("**/api/diaries/**/attachments", (route) =>
      route.fulfill({
        status: 503,
        contentType: "text/html",
        headers: { "Retry-After": "60" },
        body: "维护中",
      }),
    );
    monitor.allow(
      "POST",
      `/diaries/${created.id}/entries/${created.draft.entries[0].id}/attachments`,
      503,
    );
    await page
      .getByLabel("工作 1 添加附件", { exact: true })
      .setInputFiles(files[0]);
    await expect(page.getByRole("alert")).toContainText(
      "服务维护中，当前输入已保留，请稍后重试保存。",
    );
    await expect(
      page.getByRole("heading", { name: "附件尚未完成上传", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("首版.txt 尚未确认加入日报，请先处理。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("工作 1", { exact: true })).toHaveValue(
      "首次保存的正文",
    );
    for (const name of ["提交日报", "保存草稿"])
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeDisabled();
    await page.unroute("**/api/diaries/**/attachments");
    await page.getByRole("button", { name: "重试上传", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(
      "附件已保存到草稿，提交后团队才可见。",
    );
    diary = await read<Diary>(page, origin, `/diaries/${created.id}`);
    expect(diary).toMatchObject({
      id: created.id,
      diaryDate: null,
      published: null,
    });
    const file = diary.draft.entries[0].attachments![0];
    await expect(
      page.getByRole("link", { name: "首版.txt", exact: true }),
    ).toHaveAttribute("href", `/api/attachments/${file.id}`);
    await bytes(page, origin, file.id, originalBytes);
    await noOverflow(page);

    const savedVersion = diary.version;
    await page
      .getByLabel("工作 1", { exact: true })
      .fill("会话失效时未保存的正文");
    service.setTime(initialTime + 8 * 24 * 60 * 60 * 1000);
    monitor.allow("POST", `/diaries/${diary.id}/save`, 401);
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("请先登录。");
    await expect(page.getByRole("status")).not.toContainText("草稿已保存");
    await expect(page.getByLabel("工作 1", { exact: true })).toHaveValue(
      "会话失效时未保存的正文",
    );

    monitor.allow("GET", "/me", 401);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "登录", exact: true }),
    ).toBeVisible();
    await page.getByLabel("邮箱", { exact: true }).fill("green@example.test");
    await page.getByLabel("密码", { exact: true }).fill("TeamDiaries2026!");
    const reentered = await post<Identity>(page, "/login", () =>
      page.getByRole("button", { name: "登录", exact: true }).click(),
    );
    expect(reentered.member.id).toBe(identity.member.id);
    await page.goto(`${origin}/diaries`);
    await page.getByRole("button", { name: /重试与失效/ }).click();
    await expect(page.getByLabel("工作 1", { exact: true })).toHaveValue(
      "首次保存的正文",
    );
    await expect(page.getByLabel("日报标题", { exact: true })).toHaveValue(
      "重试与失效",
    );
    await expect(
      page.getByRole("link", { name: "首版.txt", exact: true }),
    ).toBeVisible();
    await bytes(page, origin, file.id, originalBytes);
    await page
      .getByLabel("工作 1", { exact: true })
      .fill("重新登录后补写的正文");
    diary = await post<Diary>(page, `/diaries/${diary.id}/save`, () =>
      page.getByRole("button", { name: "保存草稿", exact: true }).click(),
    );
    await expect(page.getByRole("status")).toHaveText("草稿已保存，仅你可见。");
    expect(diary.version).toBe(savedVersion + 1);
    expect(diary.draft.entries[0]).toMatchObject({
      body: "重新登录后补写的正文",
      attachments: [file],
    });
    await page.reload();
    await page.getByRole("button", { name: /重试与失效/ }).click();
    await expect(page.getByLabel("工作 1", { exact: true })).toHaveValue(
      "重新登录后补写的正文",
    );
    await noOverflow(page);
  } finally {
    monitor.check();
  }
});
