import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createApp } from "./application.ts";
import { applicationFixture } from "./support.ts";
import { legacy, seedLegacyTeam } from "./legacy-team-fixture.ts";

const firstMember = {
  name: "林晓",
  email: "lin@example.test",
  password: "QuietRiver2026!",
  teamName: "日序工作室",
};

async function start(
  t: TestContext,
  options: { databasePath?: string; now?: () => number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "daily-flow-"));
  const service = await createApp({
    databasePath: options.databasePath ?? join(directory, "test.sqlite"),
    now: options.now,
  });
  const server = await service.listen(0, "127.0.0.1");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  const origin = `http://127.0.0.1:${address.port}`;
  const stop = async () => {
    await service.close();
  };
  t.after(async () => {
    if (server.listening) await stop();
    await rm(directory, { recursive: true, force: true });
  });
  const client = () => {
    let cookie = "";
    return {
      async request(
        path: string,
        body?: object,
        method = body ? "POST" : "GET",
        headers: Record<string, string> = {},
      ) {
        const response = await fetch(`${origin}/api${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
            Cookie: cookie,
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const setCookie = response.headers.get("set-cookie");
        if (setCookie) cookie = setCookie.split(";")[0];
        return {
          status: response.status,
          data: await response.json(),
          headers: response.headers,
        };
      },
    };
  };
  return { client, stop, origin };
}

test("首位成员建立唯一团队，身份来自会话且匿名请求不能读取成员内容", async (t) => {
  const service = await start(t);
  const member = service.client();
  assert.equal((await member.request("/setup/status")).data.needsSetup, true);
  assert.equal((await member.request("/me")).status, 401);
  const created = await member.request("/setup", firstMember);
  assert.equal(created.status, 201);
  assert.match(created.headers.get("set-cookie") ?? "", /HttpOnly/);
  const me = await member.request("/me");
  assert.equal(me.data.member.name, "林晓");
  assert.equal(me.data.member.email, "lin@example.test");
  assert.equal(me.data.team.name, "日序工作室");
  assert.equal("password" in me.data.member, false);
  assert.equal("passwordHash" in me.data.member, false);
  assert.equal((await service.client().request("/me")).status, 401);
  assert.equal((await member.request("/setup/status")).data.needsSetup, false);
  assert.equal((await member.request("/setup", firstMember)).status, 409);
  const second = service.client();
  const another = await second.request("/setup", {
    ...firstMember,
    teamName: "另一个团队",
    email: "second@example.test",
    teamId: created.data.team.id,
  });
  assert.equal(another.status, 201);
  assert.notEqual(another.data.team.id, created.data.team.id);
  assert.equal(another.data.member.teamId, another.data.team.id);
  assert.deepEqual((await member.request("/me")).data, me.data);
  assert.deepEqual((await second.request("/me")).data, another.data);
});

test("创建团队按规范化名称判重，失败不注册账号或改变现有会话", async (t) => {
  const f = await applicationFixture(t);
  const owner = f.client();
  const first = await owner("/setup", { ...firstMember, teamName: "  Team  " });
  assert.equal(first.status, 201);
  assert.equal(first.data.team.name, "Team");
  for (const [index, teamName] of ["team", "Ｔｅａｍ", "  TEAM "].entries()) {
    const visitor = f.client();
    const email = `duplicate${index}@example.test`;
    const conflict = await visitor("/setup", {
      ...firstMember,
      teamName,
      email,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.error, "团队名称已被使用，请更换名称。");
    assert.equal(conflict.headers.get("set-cookie"), null);
    assert.equal((await visitor("/me")).status, 401);
    assert.equal(
      (await visitor("/login", { email, password: firstMember.password }))
        .status,
      401,
    );
    assert.equal(
      (
        await visitor("/setup", {
          ...firstMember,
          teamName: `更换名称${index}`,
          email,
        })
      ).status,
      201,
    );
  }
  const collision = await owner("/setup", {
    ...firstMember,
    teamName: "未占用名称",
  });
  assert.equal(collision.status, 409);
  assert.equal(collision.data.error, "此邮箱已注册，请直接登录。");
  assert.deepEqual((await owner("/me")).data, first.data);
  const retry = await f.client()("/setup", {
    ...firstMember,
    teamName: "未占用名称",
    email: "retry@example.test",
  });
  assert.equal(retry.status, 201);
  for (const [index, teamName] of ["研 发", "研发"].entries()) {
    assert.equal(
      (
        await f.client()("/setup", {
          ...firstMember,
          teamName,
          email: `space${index}@example.test`,
        })
      ).status,
      201,
    );
  }
  const invalid = f.client();
  for (const changes of [
    { teamName: "   " },
    { password: "short" },
    { email: "invalid" },
  ]) {
    assert.equal(
      (
        await invalid("/setup", {
          ...firstMember,
          teamName: "校验后可用",
          email: "valid@example.test",
          ...changes,
        })
      ).status,
      400,
    );
    assert.equal((await invalid("/me")).status, 401);
  }
  assert.equal(
    (
      await invalid("/setup", {
        ...firstMember,
        teamName: "校验后可用",
        email: "valid@example.test",
      })
    ).status,
    201,
  );
});

test("等价名称并发创建只有一个团队成功，失败者可换名注册且不能冒用成功账号", async (t) => {
  const f = await applicationFixture(t);
  const clients = [f.client(), f.client(), f.client()];
  const inputs = ["Team", " team ", "Ｔｅａｍ"].map((teamName, index) => ({
    ...firstMember,
    teamName,
    email: `race${index}@example.test`,
  }));
  const results = await Promise.all(
    clients.map((client, index) => client("/setup", inputs[index])),
  );
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    [201, 409, 409],
  );
  const winner = results.findIndex((result) => result.status === 201);
  for (let i = 0; i < clients.length; i++) {
    if (i === winner) {
      assert.deepEqual((await clients[i]("/me")).data, results[i].data);
      continue;
    }
    assert.equal(results[i].data.error, "团队名称已被使用，请更换名称。");
    assert.equal(results[i].headers.get("set-cookie"), null);
    assert.equal((await clients[i]("/me")).status, 401);
    assert.equal((await clients[i]("/login", inputs[i])).status, 401);
    assert.equal(
      (await clients[i]("/setup", { ...inputs[i], teamName: `并发后重试${i}` }))
        .status,
      201,
    );
  }
  await f.restart();
  assert.deepEqual((await clients[winner]("/me")).data, results[winner].data);
});

test("同邮箱并发创建不留下孤立团队，失败名称可重用且原账号归属不变", async (t) => {
  const f = await applicationFixture(t);
  const clients = [f.client(), f.client()];
  const inputs = ["并发一队", "并发二队"].map((teamName) => ({
    ...firstMember,
    teamName,
  }));
  const results = await Promise.all(
    clients.map((client, index) => client("/setup", inputs[index])),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const winner = results.findIndex((result) => result.status === 201),
    loser = 1 - winner;
  assert.equal(results[loser].data.error, "此邮箱已注册，请直接登录。");
  assert.equal(results[loser].headers.get("set-cookie"), null);
  assert.equal((await clients[loser]("/me")).status, 401);
  const retried = await clients[loser]("/setup", {
    ...inputs[loser],
    email: "retry@example.test",
  });
  assert.equal(retried.status, 201);
  assert.notEqual(retried.data.team.id, results[winner].data.team.id);
  assert.equal((await clients[winner]("/logout", {})).status, 200);
  await f.restart();
  const login = await clients[winner]("/login", {
    ...firstMember,
    teamId: retried.data.team.id,
  });
  assert.equal(login.status, 200);
  assert.deepEqual(login.data, results[winner].data);
  assert.deepEqual((await clients[loser]("/me")).data, retried.data);
  assert.equal(
    (
      await f.client()("/setup", {
        ...firstMember,
        teamName: "重启后的第三队",
        email: "third@example.test",
      })
    ).status,
    201,
  );
});

test("迁移后原团队等价名称仍被占用，新增团队及重启不改变原账号归属", async (t) => {
  const f = await applicationFixture(t, {}, seedLegacyTeam);
  const original = f.client(`daily_session=${legacy.session}`);
  const before = (await original("/me")).data;
  const visitor = f.client();
  const conflict = await visitor("/setup", {
    ...firstMember,
    teamName: "team 研发",
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, "团队名称已被使用，请更换名称。");
  assert.equal((await visitor("/me")).status, 401);
  const created = await visitor("/setup", firstMember);
  assert.equal(created.status, 201);
  assert.notEqual(created.data.team.id, legacy.team.id);
  for (let attempt = 0; attempt < 2; attempt++) {
    await f.restart();
    assert.deepEqual((await original("/me")).data, before);
    assert.deepEqual((await visitor("/me")).data, created.data);
    assert.equal(
      (
        await f.client()("/setup", {
          ...firstMember,
          teamName: `重启团队${attempt}`,
          email: `restart${attempt}@example.test`,
        })
      ).status,
      201,
    );
  }
});

test("成员退出后会话失效，重启服务后仍可用原账号登录同一团队", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "daily-flow-persistence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "persistent.sqlite");
  const firstService = await start(t, { databasePath });
  const member = firstService.client();
  const created = await member.request("/setup", firstMember);
  assert.equal((await member.request("/logout", {})).status, 200);
  assert.equal((await member.request("/me")).status, 401);
  assert.equal(
    (
      await member.request("/login", {
        email: firstMember.email,
        password: "WrongPassword2026!",
      })
    ).status,
    401,
  );
  await firstService.stop();
  const restarted = await start(t, { databasePath });
  const returning = restarted.client();
  assert.equal(
    (
      await returning.request("/login", {
        email: "LIN@EXAMPLE.TEST",
        password: firstMember.password,
      })
    ).status,
    200,
  );
  const me = await returning.request("/me");
  assert.equal(me.data.member.id, created.data.member.id);
  assert.equal(me.data.team.name, "日序工作室");
  await restarted.stop();
});

test("邀请第二位成员加入同一团队，普通成员也可邀请且重复使用不会创建成员", async (t) => {
  const service = await start(t);
  const owner = service.client();
  await owner.request("/setup", firstMember);
  const invitation = await owner.request("/invitations", {});
  assert.equal(invitation.status, 201);
  const visitor = service.client();
  const preview = await visitor.request("/invitations/preview", {
    token: invitation.data.token,
  });
  assert.equal(preview.data.team.name, "日序工作室");
  assert.equal(preview.data.invitedBy, "林晓");
  const joined = await visitor.request("/join", {
    token: invitation.data.token,
    name: "周宁",
    email: "zhou@example.test",
    password: "SecondMember2026!",
  });
  assert.equal(joined.status, 201);
  assert.equal(joined.data.team.id, (await owner.request("/me")).data.team.id);
  assert.equal((await visitor.request("/me")).data.member.name, "周宁");
  assert.equal(
    (await visitor.request("/invitations", { creatorId: "fake-member-id" }))
      .status,
    201,
  );
  const ownInvitations = await visitor.request("/invitations");
  assert.equal(ownInvitations.data.invitations.length, 1);
  assert.equal(
    ownInvitations.data.invitations[0].createdBy,
    joined.data.member.id,
  );
  const reused = await service.client().request("/join", {
    token: invitation.data.token,
    name: "未授权成员",
    email: "intruder@example.test",
    password: "ThirdMember2026!",
  });
  assert.equal(reused.status, 410);
  assert.equal(
    (
      await service.client().request("/login", {
        email: "intruder@example.test",
        password: "ThirdMember2026!",
      })
    ).status,
    401,
  );
  const listed = await owner.request("/invitations");
  assert.equal(listed.data.invitations[0].status, "used");
  assert.equal("token" in listed.data.invitations[0], false);
});

test("邀请只有生成者可以撤销，撤销及满七天的邀请均不能加入", async (t) => {
  let time = Date.parse("2026-09-16T04:00:00Z");
  const service = await start(t, { now: () => time });
  const owner = service.client();
  await owner.request("/setup", firstMember);
  const seed = await owner.request("/invitations", {});
  const other = service.client();
  await other.request("/join", {
    token: seed.data.token,
    name: "周宁",
    email: "zhou@example.test",
    password: "SecondMember2026!",
  });
  const target = await owner.request("/invitations", {});
  assert.equal(
    (
      await other.request(
        `/invitations/${target.data.invitation.id}/revoke`,
        {},
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await owner.request(
        `/invitations/${target.data.invitation.id}/revoke`,
        {},
      )
    ).status,
    200,
  );
  assert.equal(
    (await other.request("/invitations/preview", { token: target.data.token }))
      .status,
    410,
  );
  assert.equal(
    (
      await other.request("/join", {
        token: target.data.token,
        name: "新人",
        email: "new@example.test",
        password: "NewMember2026!",
      })
    ).status,
    410,
  );
  const expiring = await owner.request("/invitations", {});
  assert.equal(
    expiring.data.invitation.expiresAt,
    Date.parse("2026-09-23T04:00:00Z"),
  );
  time = Date.parse("2026-09-23T04:00:00Z");
  assert.equal(
    (
      await service.client().request("/join", {
        token: expiring.data.token,
        name: "新人",
        email: "new@example.test",
        password: "NewMember2026!",
      })
    ).status,
    410,
  );
  assert.equal((await owner.request("/me")).status, 401);
  await owner.request("/login", firstMember);
  const statuses = (await owner.request("/invitations")).data.invitations.map(
    (item: { status: string }) => item.status,
  );
  assert.deepEqual(statuses, ["expired", "revoked", "used"]);
});

test("公开创建保留跨站来源、伪造主机、密码规则与频率限制", async (t) => {
  const service = await start(t);
  const visitor = service.client();
  assert.equal(
    (
      await visitor.request("/setup", firstMember, "POST", {
        Origin: "https://unrelated.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await visitor.request("/setup", firstMember, "POST", { Origin: "" }))
      .status,
    403,
  );
  const forgedHostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      const request = httpRequest(
        `${service.origin}/api/setup/status`,
        { headers: { Host: "unrelated.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    },
  );
  assert.equal(forgedHostStatus, 403);
  assert.equal(
    (await visitor.request("/setup", { ...firstMember, password: "short" }))
      .status,
    400,
  );
  for (let attempt = 0; attempt < 19; attempt++) {
    await visitor.request("/setup", { ...firstMember, password: "short" });
  }
  assert.equal((await visitor.request("/setup", firstMember)).status, 429);
  assert.equal((await visitor.request("/setup/status")).data.needsSetup, true);
});

test("同一邀请并发接受只成功一次；注册邮箱冲突不消耗有效邀请", async (t) => {
  const service = await start(t);
  const owner = service.client();
  await owner.request("/setup", firstMember);
  const invite = await owner.request("/invitations", {});
  assert.equal(
    (
      await service
        .client()
        .request("/join", { ...firstMember, token: invite.data.token })
    ).status,
    409,
  );
  assert.equal(
    (
      await service
        .client()
        .request("/invitations/preview", { token: invite.data.token })
    ).status,
    200,
  );
  const results = await Promise.all(
    ["one", "two"].map((name) =>
      service.client().request("/join", {
        token: invite.data.token,
        name,
        email: `${name}@example.test`,
        password: "Concurrent2026!",
      }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 410]);
  const failedEmail =
    results[0].status === 410 ? "one@example.test" : "two@example.test";
  assert.equal(
    (
      await service
        .client()
        .request("/login", { email: failedEmail, password: "Concurrent2026!" })
    ).status,
    401,
  );
});
