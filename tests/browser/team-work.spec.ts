import { expect, test as base, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../application.ts";
import type {
  Diary,
  Identity,
  Project,
  PublishedDiary,
  Task,
  TaskEvent,
} from "../../src/shared/contracts.ts";

const test = base.extend<{ origin: string }>({
  origin: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "daily-team-work-"));
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

async function createTeam(page: Page, origin: string, suffix: string) {
  const response = await page.request.post(`${origin}/api/setup`, {
    headers: { Origin: origin },
    data: {
      teamName: `${suffix}团队`,
      name: `${suffix}成员`,
      email: `${suffix === "青山" ? "green" : "blue"}@example.test`,
      password: "TeamWork2026!",
    },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

async function createWork(page: Page, origin: string) {
  const projectResponse = await page.request.post(`${origin}/api/projects`, {
    headers: { Origin: origin },
    data: { name: "任务编辑项目", description: "项目说明" },
  });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json();
  const taskResponse = await page.request.post(
    `${origin}/api/projects/${project.id}/tasks`,
    {
      headers: { Origin: origin },
      data: { name: "任务编辑验证", description: "保留任务说明" },
    },
  );
  expect(taskResponse.status()).toBe(201);
  return { project, task: await taskResponse.json() };
}

test("任务编辑入口明确说明可修改名称和说明", async ({ page, origin }) => {
  await createTeam(page, origin, "青山");
  const { project, task } = await createWork(page, origin);
  await page.goto(`${origin}/projects?project=${project.id}&task=${task.id}`);
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  await expect(
    detail.getByRole("heading", { name: "任务编辑验证", exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole("button", { name: "编辑任务名称和说明", exact: true }),
  ).toBeVisible();
  await detail
    .getByRole("button", { name: "编辑任务名称和说明", exact: true })
    .click();
  await expect(page.getByLabel("任务名称", { exact: true })).toHaveValue(
    "任务编辑验证",
  );
  await expect(
    page.getByRole("textbox", { name: "任务原始说明", exact: true }),
  ).toHaveValue("保留任务说明");
});

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
  return { errors, allowed };
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    `horizontal overflow at ${page.url()}`,
  ).toBe(true);
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

async function confirm(page: Page, button: string, message: string) {
  const pending = page.waitForEvent("dialog");
  const clicked = page
    .getByRole("button", { name: button, exact: true })
    .click();
  const dialog = await pending;
  expect(dialog.message()).toContain(message);
  await dialog.accept();
  await clicked;
}

async function maintainWork(
  page: Page,
  origin: string,
  identity: Identity,
  prefix: string,
) {
  await page.goto(`${origin}/projects`);
  await expect(
    page.getByRole("heading", { name: "项目与任务", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "＋ 新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill(`${prefix}项目`);
  await page
    .getByRole("textbox", { name: "项目说明", exact: true })
    .fill(`${prefix}项目说明`);
  await noOverflow(page);
  let project = await post<Project>(
    page,
    "/projects",
    () => page.getByRole("button", { name: "保存项目", exact: true }).click(),
    201,
  );
  expect(project).toMatchObject({
    name: `${prefix}项目`,
    description: `${prefix}项目说明`,
    creator: { id: identity.member.id, name: identity.member.name },
    archived: false,
  });
  await expect(
    page.getByRole("heading", { name: project.name, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "编辑项目资料", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill(`${prefix}交付项目`);
  await page
    .getByRole("textbox", { name: "项目说明", exact: true })
    .fill(`${prefix}更新后的项目说明`);
  project = await post<Project>(page, `/projects/${project.id}/save`, () =>
    page.getByRole("button", { name: "保存项目", exact: true }).click(),
  );
  expect(project.name).toBe(`${prefix}交付项目`);
  expect(project.description).toBe(`${prefix}更新后的项目说明`);
  await expect(
    page.getByText(project.description, { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "＋ 新建任务", exact: true }).click();
  await page.getByLabel("任务名称", { exact: true }).fill(`${prefix}任务`);
  await page
    .getByRole("textbox", { name: "任务原始说明", exact: true })
    .fill(`${prefix}任务说明`);
  await noOverflow(page);
  let task = await post<Task>(
    page,
    `/projects/${project.id}/tasks`,
    () => page.getByRole("button", { name: "保存任务", exact: true }).click(),
    201,
  );
  expect(task).toMatchObject({
    name: `${prefix}任务`,
    projectId: project.id,
    creator: { id: identity.member.id, name: identity.member.name },
    status: "pending",
    version: 1,
    archived: false,
  });
  const detail = page.getByRole("region", { name: "任务详情", exact: true });
  await expect(
    detail.getByRole("heading", { name: task.name, exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByText("尚无状态变更。", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "编辑任务名称和说明", exact: true })
    .click();
  await page.getByLabel("任务名称", { exact: true }).fill(`${prefix}交付任务`);
  await page
    .getByRole("textbox", { name: "任务原始说明", exact: true })
    .fill(`${prefix}更新后的任务说明`);
  task = await post<Task>(page, `/tasks/${task.id}/save`, () =>
    page.getByRole("button", { name: "保存任务", exact: true }).click(),
  );
  expect(task).toMatchObject({
    name: `${prefix}交付任务`,
    description: `${prefix}更新后的任务说明`,
    status: "pending",
    version: 1,
  });
  await expect(
    detail.getByText(task.description, { exact: true }),
  ).toBeVisible();
  await noOverflow(page);

  // The existing diary submission UI is the web status-update boundary.
  await page.getByRole("button", { name: "我的日报", exact: true }).click();
  const draft = await post<Diary>(
    page,
    "/diaries",
    () =>
      page.getByRole("button", { name: "＋ 新建日报", exact: true }).click(),
    201,
  );
  await page.getByLabel("日报标题", { exact: true }).fill(`${prefix}交付日报`);
  await page
    .getByLabel("工作 1", { exact: true })
    .fill(`${prefix}已完成验收的工作内容`);
  await page.getByLabel("工作 1", { exact: true }).press("Shift+Digit2");
  await page
    .getByLabel("工作 1 关联项目", { exact: true })
    .selectOption(project.id);
  await page.getByText("关联任务或更新状态（选填）", { exact: true }).click();
  await page.getByLabel("工作 1 任务", { exact: true }).selectOption(task.id);
  await page
    .getByLabel("工作 1 更新状态", { exact: true })
    .selectOption("done");
  await noOverflow(page);
  const diary = await post<Diary>(page, `/diaries/${draft.id}/submit`, () =>
    page.getByRole("button", { name: "提交日报", exact: true }).click(),
  );
  expect(diary.published).toMatchObject({
    title: `${prefix}交付日报`,
    entries: [
      {
        body: `${prefix}已完成验收的工作内容`,
        projectId: project.id,
        taskId: task.id,
        taskStatus: "done",
      },
    ],
  });
  await expect(page.getByRole("status")).toContainText("日报已提交");

  await page.goto(`${origin}/projects?project=${project.id}&task=${task.id}`);
  await expect(detail).toContainText("当前任务状态：已完成");
  await expect(detail).toContainText("待开始 → 已完成");
  await expect(detail).toContainText("日报提交 / 网页");
  await expect(
    detail.getByText(`${prefix}已完成验收的工作内容`, { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole("heading", { name: "任务进展", exact: true }),
  ).toBeVisible();
  const progressResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      `/api/projects/${project.id}/progress`,
  );
  await page.getByRole("button", { name: "查看进展", exact: true }).click();
  const progress = await progressResponse;
  expect(progress.status()).toBe(200);
  expect(await progress.json()).toMatchObject([
    {
      id: diary.id,
      author: { id: identity.member.id, name: identity.member.name },
      published: { title: "", entries: diary.published!.entries },
    },
  ]);
  await expect(
    page.getByText(`${prefix}已完成验收的工作内容`, { exact: true }),
  ).toHaveCount(2);
  task = await read<Task>(page, origin, `/tasks/${task.id}`);
  expect(task).toMatchObject({ status: "done", version: 2 });
  const events = await read<TaskEvent[]>(
    page,
    origin,
    `/tasks/${task.id}/events`,
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    member: { name: identity.member.name },
    before: "pending",
    after: "done",
    kind: "diary",
    channel: "web",
  });
  await noOverflow(page);

  for (const archived of [true, false]) {
    task = await post<Task>(page, `/tasks/${task.id}/archive`, () =>
      confirm(
        page,
        archived ? "归档任务" : "恢复任务",
        archived ? "历史进展" : "不会自动恢复",
      ),
    );
    expect(task).toMatchObject({ archived, status: "done", version: 2 });
    const row = page.getByRole("button", {
      name: new RegExp(`${task.name} 已完成`),
    });
    if (archived) await expect(row).toContainText("已归档");
    else await expect(row).not.toContainText("已归档");
    await expect(
      detail.getByText(`${prefix}已完成验收的工作内容`, { exact: true }),
    ).toBeVisible();
    await noOverflow(page);
  }
  for (const archived of [true, false]) {
    project = await post<Project>(page, `/projects/${project.id}/archive`, () =>
      confirm(
        page,
        archived ? "归档项目" : "恢复项目",
        archived ? "历史条目" : "不会自动恢复",
      ),
    );
    expect(project.archived).toBe(archived);
    const create = page.getByRole("button", {
      name: "＋ 新建任务",
      exact: true,
    });
    if (archived) {
      await expect(create).toBeDisabled();
      await expect(
        page.getByText(
          "项目已归档，保留历史，停止新增进展。恢复后旧公开链接仍保持关闭。",
          { exact: true },
        ),
      ).toBeVisible();
    } else await expect(create).toBeEnabled();
    await noOverflow(page);
  }
  return { project, task, diary, events };
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`两个团队的项目任务维护、日报状态更新与隔离 ${viewport.width}`, async ({
    page,
    browser,
    origin,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(viewport);
    const secondContext = await browser.newContext({ viewport });
    const second = await secondContext.newPage();
    const observed = [observeErrors(page), observeErrors(second)];
    try {
      const firstIdentity: Identity = await createTeam(page, origin, "青山");
      const secondIdentity: Identity = await createTeam(second, origin, "蓝海");
      expect(secondIdentity.team.id).not.toBe(firstIdentity.team.id);
      expect(secondIdentity.member.id).not.toBe(firstIdentity.member.id);
      const firstWork = await maintainWork(page, origin, firstIdentity, "青山");
      const secondWork = await maintainWork(
        second,
        origin,
        secondIdentity,
        "蓝海",
      );

      for (const [current, own, foreign, identity, monitor] of [
        [page, firstWork, secondWork, firstIdentity, observed[0]],
        [second, secondWork, firstWork, secondIdentity, observed[1]],
      ] as const) {
        await current.goto(`${origin}/projects`);
        const list = await read<Project[]>(current, origin, "/projects");
        expect(list).toEqual([own.project]);
        await expect(
          current.getByRole("button", { name: new RegExp(own.project.name) }),
        ).toBeVisible();
        await expect(
          current.getByText(foreign.project.name, { exact: true }),
        ).toHaveCount(0);
        await expect(
          current.getByText(foreign.task.name, { exact: true }),
        ).toHaveCount(0);
        await current
          .getByRole("button", { name: new RegExp(own.project.name) })
          .click();
        await current
          .getByRole("button", { name: new RegExp(own.task.name) })
          .click();
        await expect(
          current.getByRole("region", { name: "任务详情" }),
        ).toContainText(own.task.description);
        await expect(
          current.getByRole("region", { name: "任务详情" }),
        ).toContainText("待开始 → 已完成");
        expect(
          await read<Task[]>(
            current,
            origin,
            `/projects/${own.project.id}/tasks`,
          ),
        ).toEqual([own.task]);
        for (const path of [
          `/projects/${own.project.id}/progress`,
          `/tasks/${own.task.id}/progress`,
        ]) {
          const records = await read<PublishedDiary[]>(current, origin, path);
          expect(records).toHaveLength(1);
          expect(records[0]).toMatchObject({
            id: own.diary.id,
            author: { id: identity.member.id, name: identity.member.name },
            published: { title: "", entries: own.diary.published!.entries },
          });
          expect(JSON.stringify(records)).not.toContain(foreign.diary.id);
          expect(JSON.stringify(records)).not.toContain(foreign.task.name);
        }
        await noOverflow(current);
        for (const path of [
          `/projects/${foreign.project.id}`,
          `/projects/${foreign.project.id}/tasks`,
          `/projects/${foreign.project.id}/progress`,
          `/tasks/${foreign.task.id}`,
          `/tasks/${foreign.task.id}/progress`,
          `/tasks/${foreign.task.id}/events`,
        ]) {
          const denied = await current.request.get(`${origin}/api${path}`);
          expect(denied.status(), path).toBe(404);
          const body = await denied.json();
          expect(Object.keys(body)).toEqual(["error"]);
          expect(body.error).toEqual(expect.any(String));
          expect(JSON.stringify(body)).not.toMatch(/青山|蓝海/);
          expect(JSON.stringify(body)).not.toContain(foreign.project.id);
          expect(JSON.stringify(body)).not.toContain(foreign.task.id);
        }
        for (const [path, url] of [
          [
            `/projects/${foreign.project.id}`,
            `${origin}/projects?project=${foreign.project.id}`,
          ],
          [
            `/tasks/${foreign.task.id}`,
            `${origin}/projects?project=${own.project.id}&task=${foreign.task.id}`,
          ],
        ]) {
          monitor.allowed.add(`GET /api${path} 404`);
          const response = current.waitForResponse(
            (response) => new URL(response.url()).pathname === `/api${path}`,
          );
          await current.goto(url);
          const denied = await response;
          expect(denied.status()).toBe(404);
          const body = await denied.json();
          await expect(current.getByRole("alert")).toHaveText(body.error);
          await expect(
            current.getByText(foreign.project.name, { exact: true }),
          ).toHaveCount(0);
          await expect(
            current.getByText(foreign.task.name, { exact: true }),
          ).toHaveCount(0);
          await expect(
            current.getByRole("region", { name: "任务详情" }),
          ).toHaveCount(0);
          await noOverflow(current);
        }
      }
      for (const [current, own] of [
        [page, firstWork],
        [second, secondWork],
      ] as const) {
        expect(
          await read<Project>(current, origin, `/projects/${own.project.id}`),
        ).toEqual(own.project);
        expect(
          await read<Task>(current, origin, `/tasks/${own.task.id}`),
        ).toEqual(own.task);
        expect(
          await read<TaskEvent[]>(
            current,
            origin,
            `/tasks/${own.task.id}/events`,
          ),
        ).toEqual(own.events);
      }
    } finally {
      for (const monitor of observed) expect.soft(monitor.errors).toEqual([]);
      await secondContext.close();
    }
  });
}
