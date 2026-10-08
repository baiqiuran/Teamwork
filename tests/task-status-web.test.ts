import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fixture } from "./support.ts";

test("网页独立状态更新允许同团队成员操作，保留提交快照并校验版本", async (t) => {
  const f = await fixture(t);
  const project = (
    await f.author("/projects", { name: "状态项目", description: "" })
  ).data;
  const task = (
    await f.author(`/projects/${project.id}/tasks`, {
      name: "状态任务",
      description: "原始说明",
    })
  ).data;
  const diary = (
    await f.author("/diaries", {
      title: "提交快照",
      entries: [
        {
          id: randomUUID(),
          body: "已提交进展",
          projectId: project.id,
          taskId: task.id,
        },
      ],
    })
  ).data;
  const published = await f.author(`/diaries/${diary.id}/submit`, {
    version: diary.version,
    requestId: randomUUID(),
  });
  assert.equal(published.status, 200);
  assert.equal(published.data.published.entries[0].taskStatus, "pending");

  const updated = await f.colleague(`/tasks/${task.id}/status`, {
    status: "in-progress",
    expectedVersion: 1,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.status, "in-progress");
  assert.equal(updated.data.version, 2);
  const events = (await f.author(`/tasks/${task.id}/events`)).data;
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "direct");
  assert.equal(events[0].channel, "web");
  assert.equal(events[0].diaryId, null);
  assert.equal(events[0].member.id, f.other.member.id);
  assert.equal(events[0].before, "pending");
  assert.equal(events[0].after, "in-progress");

  const same = await f.author(`/tasks/${task.id}/status`, {
    status: "in-progress",
    expectedVersion: 2,
  });
  assert.equal(same.status, 200);
  assert.equal(same.data.version, 2);
  assert.equal((await f.author(`/tasks/${task.id}/events`)).data.length, 1);
  const conflict = await f.author(`/tasks/${task.id}/status`, {
    status: "done",
    expectedVersion: 1,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.details.latestStatus, "in-progress");
  assert.deepEqual((await f.author(`/tasks/${task.id}`)).data, updated.data);
  assert.deepEqual((await f.author(`/tasks/${task.id}/events`)).data, events);
  const progress = (await f.author(`/tasks/${task.id}/progress`)).data;
  assert.equal(progress.length, 1);
  assert.equal(progress[0].published.entries[0].taskStatus, "pending");
});

test("网页状态更新拒绝匿名、外团队、非法输入及已归档对象", async (t) => {
  const f = await fixture(t);
  const project = (
    await f.author("/projects", { name: "受保护项目", description: "" })
  ).data;
  const task = (
    await f.author(`/projects/${project.id}/tasks`, {
      name: "受保护任务",
      description: "",
    })
  ).data;
  const foreign = f.client();
  assert.equal(
    (
      await foreign("/setup", {
        teamName: "外团队",
        name: "外队成员",
        email: "foreign-state@example.test",
        password: "TaskStatus2026!",
      })
    ).status,
    201,
  );
  const input = { status: "done", expectedVersion: 1 };
  assert.equal((await f.guest(`/tasks/${task.id}/status`, input)).status, 401);
  const denied = await foreign(`/tasks/${task.id}/status`, input);
  assert.equal(denied.status, 404);
  assert.deepEqual(Object.keys(denied.data), ["error"]);
  for (const invalid of [
    { ...input, status: "invalid" },
    { status: "done" },
    { ...input, expectedVersion: 0 },
    { ...input, expectedVersion: 1.5 },
    { ...input, memberId: f.other.member.id },
  ]) {
    assert.equal(
      (await f.author(`/tasks/${task.id}/status`, invalid)).status,
      400,
    );
  }
  await f.author(`/tasks/${task.id}/archive`, { archived: true });
  assert.equal(
    (await f.colleague(`/tasks/${task.id}/status`, input)).status,
    409,
  );
  await f.author(`/tasks/${task.id}/archive`, { archived: false });
  await f.author(`/projects/${project.id}/archive`, { archived: true });
  assert.equal(
    (await f.colleague(`/tasks/${task.id}/status`, input)).status,
    409,
  );
  assert.equal((await f.author(`/tasks/${task.id}`)).data.status, "pending");
  assert.equal((await f.author(`/tasks/${task.id}`)).data.version, 1);
  assert.deepEqual((await f.author(`/tasks/${task.id}/events`)).data, []);
});
