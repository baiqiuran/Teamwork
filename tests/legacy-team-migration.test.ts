import assert from "node:assert/strict";
import { test } from "node:test";
import { applicationFixture } from "./support.ts";
import {
  legacy,
  seedLegacyTeam,
  seedLegacyAuthorization,
} from "./legacy-team-fixture.ts";
import { mcpClient } from "./mcp-support.ts";
import {
  seedLegacyWork,
  oldIds,
  oldContent,
  oldSubmission,
  oldTask,
  oldOperation,
} from "./legacy-team-fixture.ts";

test("升级保留邀请所属团队、原到期时间与单次使用状态", async (t) => {
  const f = await applicationFixture(t, {}, seedLegacyWork);
  const guest = f.client();
  const registration = {
    name: "受邀成员",
    email: "joined@example.test",
    password: legacy.password,
  };
  for (const token of [
    "invite-revoked",
    "invite-used",
    "invite-expired",
    "forged",
  ]) {
    assert.equal((await guest("/invitations/preview", { token })).status, 410);
    assert.equal(
      (await guest("/join", { ...registration, token })).status,
      410,
    );
  }
  const preview = await guest("/invitations/preview", {
    token: "invite-active",
  });
  assert.deepEqual(preview.data.team, legacy.team);
  assert.equal(preview.data.invitedBy, legacy.member.name);
  assert.equal(preview.data.expiresAt, Date.parse("2026-09-23T03:00:00Z"));
  assert.equal(
    (
      await guest("/join", {
        ...registration,
        token: "invite-active",
        email: legacy.member.email,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await guest("/join", {
        ...registration,
        token: "invite-active",
        password: "short",
      })
    ).status,
    400,
  );
  assert.equal(
    (await guest("/invitations/preview", { token: "invite-active" })).status,
    200,
  );
  const joined = await guest("/join", {
    ...registration,
    token: "invite-active",
  });
  assert.equal(joined.status, 201);
  assert.deepEqual(joined.data.team, legacy.team);
  assert.equal(joined.data.member.teamId, legacy.team.id);
  await f.restart();
  assert.deepEqual((await guest("/me")).data.team, legacy.team);
  assert.equal(
    (await f.client()("/invitations/preview", { token: "invite-active" }))
      .status,
    410,
  );
});

test("迁移后的数据库继续开放创建团队，新团队看不到原团队任何数据", async (t) => {
  const f = await applicationFixture(t, {}, seedLegacyWork);
  const second = f.client();
  const created = await second("/setup", {
    teamName: "蓝海团队",
    name: "蓝海成员",
    email: "second-team@example.test",
    password: "SecondTeam2026!",
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.notEqual(created.data.team.id, legacy.team.id);
  for (const path of [
    `/projects/${oldIds.project}`,
    `/tasks/${oldIds.task}`,
    `/tasks/${oldIds.task}/events`,
    `/diaries/${oldIds.diary}`,
    `/team-diaries/${oldIds.diary}`,
    `/attachments/${oldIds.attachment}`,
  ])
    assert.equal((await second(path)).status, 404, path);
  assert.deepEqual((await second("/projects")).data, []);
  assert.deepEqual((await second("/diaries/mine")).data, []);
  assert.deepEqual((await second("/invitations")).data.invitations, []);
  assert.deepEqual((await second("/diary-events")).data, []);
  assert.deepEqual(
    (await second("/team-diaries?from=2026-09-16&to=2026-09-16")).data,
    [],
  );
  assert.deepEqual((await second("/members")).data, [
    {
      id: created.data.member.id,
      name: "蓝海成员",
      joinedAt: Date.parse("2026-09-16T15:59:00Z"),
      lastDiaryDate: null,
    },
  ]);
  const visible = JSON.stringify([
    (await second("/projects")).data,
    (await second("/members")).data,
    (await second("/team-diaries?from=2026-09-16&to=2026-09-16")).data,
  ]);
  for (const secret of [
    "原项目",
    "原任务",
    "迁移前已完成的工作",
    legacy.member.email,
    "colleague@example.test",
  ])
    assert.ok(!visible.includes(secret), visible);
  const owner = f.client(`daily_session=${legacy.session}`);
  assert.equal((await owner(`/projects/${oldIds.project}`)).status, 200);
  assert.deepEqual(
    (await owner("/members")).data.map((row: any) => row.name),
    ["原同事", "原成员"],
  );
  await f.restart();
  assert.equal((await second(`/diaries/${oldIds.diary}`)).status, 404);
  assert.equal((await owner(`/tasks/${oldIds.task}`)).status, 200);
});

test("旧工作内容、状态关联、附件字节、分享与本人回执在升级和重启后保持原意", async (t) => {
  const f = await applicationFixture(t, {}, seedLegacyWork);
  const owner = f.client(`daily_session=${legacy.session}`);
  const colleague = f.client("daily_session=legacy-colleague-session");
  const guest = f.client();
  for (let run = 0; run < 2; run++) {
    const diary = (await owner(`/diaries/${oldIds.diary}`)).data;
    assert.deepEqual(diary.published, oldContent);
    assert.equal(diary.draft.title, "原日报待重提");
    assert.equal(diary.version, 3);
    assert.equal(diary.authorId, legacy.member.id);
    assert.equal(diary.firstSubmittedAt, legacy.at);
    assert.equal(
      (await owner(`/diaries/${oldIds.draft}`)).data.draft.entries[0].body,
      "未提交的原内容",
    );
    assert.equal((await colleague(`/diaries/${oldIds.draft}`)).status, 404);
    assert.deepEqual((await owner(`/tasks/${oldIds.task}`)).data, oldTask);
    const events = (await owner(`/tasks/${oldIds.task}/events`)).data;
    assert.equal(events.length, 2);
    assert.equal(
      events.find((e: any) => e.id === oldIds.event).diaryId,
      oldIds.diary,
    );
    assert.deepEqual(
      events.find((e: any) => e.id === oldIds.directEvent),
      {
        id: oldIds.directEvent,
        diaryId: null,
        kind: "direct",
        channel: "mcp",
        member: { id: oldIds.colleague, name: "原同事" },
        before: "in-progress",
        after: "done",
        at: legacy.at + 1000,
      },
    );
    assert.equal(
      (await owner("/diary-events")).data[0].member.id,
      oldIds.colleague,
    );
    // The migrated roster keeps each original account's own creation time as its join date.
    assert.deepEqual(
      (await owner("/members")).data.map((row: any) => [
        row.name,
        row.joinedAt,
        row.lastDiaryDate,
      ]),
      [
        ["原同事", legacy.joinedAt, null],
        ["原成员", legacy.joinedAt, "2026-09-16"],
      ],
    );
    assert.ok(
      !(await owner("/members")).data.some((row: any) => "email" in row),
    );
    assert.equal(
      (await owner(`/attachments/${oldIds.attachment}`)).data,
      "legacy attachment!",
    );
    assert.deepEqual(
      (
        await owner(`/diaries/${oldIds.diary}/submit`, {
          version: 1,
          requestId: oldIds.request,
        })
      ).data,
      oldSubmission,
    );
    for (const type of ["diary", "project", "task"]) {
      const result = await guest(`/public/public-${type}`);
      assert.equal(result.status, 200);
      const text = JSON.stringify(result.data);
      assert.match(text, /迁移前已完成的工作/);
      assert.ok(
        !text.includes("原日报待重提") &&
          !text.includes("未提交的原内容") &&
          !text.includes(legacy.member.email),
      );
      assert.equal(
        (await guest(`/public/public-${type}/attachments/${oldIds.attachment}`))
          .data,
        "legacy attachment!",
      );
    }
    assert.equal((await guest("/public/public-closed")).status, 410);
    assert.equal(
      (await guest(`/public/public-closed/attachments/${oldIds.attachment}`))
        .status,
      410,
    );
    const history = (await owner("/ai/operations")).data;
    assert.ok(JSON.stringify(history).includes(oldIds.audit));
    assert.ok(
      !JSON.stringify((await colleague("/ai/operations")).data).includes(
        oldIds.audit,
      ),
    );
    for (const token of ["dfk_legacy-key", "legacy-oauth"]) {
      const client = await mcpClient(f.origin, token);
      try {
        const result = await client.callTool({
          name: "create_task",
          arguments: oldOperation,
        });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        assert.deepEqual(result.structuredContent, {
          objectId: oldIds.task,
          executedAt: legacy.at,
          task: { ...oldTask, status: "pending", version: 1 },
          replayed: true,
        });
      } finally {
        await client.close();
      }
    }
    assert.equal(
      (await owner(`/projects/${oldIds.project}/tasks`)).data.length,
      1,
    );
    assert.deepEqual((await owner(`/tasks/${oldIds.task}`)).data, oldTask);
    if (run === 0) await f.restart();
  }
});

test("旧 OAuth 与成员 Key 的 MCP 身份保留原成员团队及能力，失效状态不复活", async (t) => {
  const f = await applicationFixture(t, {}, seedLegacyAuthorization);
  const owner = f.client(`daily_session=${legacy.session}`);
  for (const token of ["dfk_legacy-key", "legacy-oauth"]) {
    const client = await mcpClient(f.origin, token);
    try {
      const context = await client.callTool({
        name: "get_context",
        arguments: {},
      });
      assert.equal(context.isError, undefined, JSON.stringify(context));
      const data = JSON.parse(JSON.stringify(context.structuredContent));
      assert.deepEqual(data.member, {
        id: legacy.member.id,
        name: legacy.member.name,
      });
      assert.deepEqual(data.scopes, ["progress:read", "tasks:write"]);
      // 团队归属只能由服务端凭据推出：成员名单按团队范围查询，归属丢失时结果为空。
      const roster = await client.callTool({
        name: "list_members",
        arguments: { limit: 20 },
      });
      assert.deepEqual(
        JSON.parse(JSON.stringify(roster.structuredContent)).items,
        [{ id: legacy.member.id, name: legacy.member.name }],
      );
      assert.equal(
        (await client.listTools()).tools.some(
          (tool) => tool.name === "submit_diary",
        ),
        false,
      );
    } finally {
      await client.close();
    }
  }
  for (const token of [
    "dfk_legacy-revoked-key",
    "legacy-revoked-oauth",
    "legacy-expired-oauth",
    "missing",
  ]) {
    const response = await fetch(`${f.origin}/mcp`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 401);
    await response.text();
  }
  for (const id of ["legacy-key", "legacy-oauth"]) {
    assert.equal((await owner(`/ai/connections/${id}/revoke`, {})).status, 201);
  }
  await f.restart();
  for (const token of ["dfk_legacy-key", "legacy-oauth"]) {
    const response = await fetch(`${f.origin}/mcp`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 401);
    await response.text();
  }
});

test("旧单团队账号迁移后会话具有明确归属，原密码登录和重复启动保持身份", async (t) => {
  const f = await applicationFixture(t, {}, seedLegacyTeam);
  const owner = f.client(`daily_session=${legacy.session}`);
  const expected = {
    member: { ...legacy.member, teamId: legacy.team.id },
    team: legacy.team,
  };
  const session = await owner("/me");
  assert.equal(session.status, 200);
  assert.deepEqual(session.data, expected);
  assert.equal(session.headers.get("set-cookie"), null);
  assert.equal(
    (await f.client("daily_session=legacy-expired-session")("/me")).status,
    401,
  );
  assert.equal(
    (await f.client("daily_session=missing-session")("/me")).status,
    401,
  );
  for (let i = 0; i < 2; i++) {
    await f.restart();
    assert.deepEqual((await owner("/me")).data, expected);
    assert.equal((await f.client()("/setup/status")).data.needsSetup, false);
  }
  await owner("/logout", {});
  assert.equal((await owner("/me")).status, 401);
  assert.equal(
    (await f.client(`daily_session=${legacy.session}`)("/me")).status,
    401,
  );
  const login = await owner("/login", {
    email: legacy.member.email,
    password: legacy.password,
  });
  assert.equal(login.status, 200);
  assert.deepEqual(login.data, expected);
  assert.deepEqual((await owner("/me")).data, expected);
});
