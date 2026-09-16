import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createApp } from "../server/app.ts";

const firstMember = {
  name: "林晓",
  email: "lin@example.test",
  password: "QuietRiver2026!",
  teamName: "日序工作室",
  setupKey: "local-test-key",
};

async function start(
  t: TestContext,
  options: { databasePath?: string; now?: () => number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "daily-flow-"));
  const service = createApp({
    databasePath: options.databasePath ?? join(directory, "test.sqlite"),
    setupKey: "local-test-key",
    now: options.now,
  });
  const server = service.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  const origin = `http://127.0.0.1:${address.port}`;
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    service.close();
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
  const reused = await service
    .client()
    .request("/join", {
      token: invitation.data.token,
      name: "未授权成员",
      email: "intruder@example.test",
      password: "ThirdMember2026!",
    });
  assert.equal(reused.status, 410);
  assert.equal(
    (
      await service
        .client()
        .request("/login", {
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
      await service
        .client()
        .request("/join", {
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

test("账号写入拒绝跨站来源、伪造主机和无引导密钥，并限制反复尝试", async (t) => {
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
    (await visitor.request("/setup", { ...firstMember, setupKey: "wrong" }))
      .status,
    403,
  );
  assert.equal(
    (await visitor.request("/setup", { ...firstMember, password: "short" }))
      .status,
    400,
  );
  for (let attempt = 0; attempt < 19; attempt++) {
    await visitor.request("/setup", { ...firstMember, setupKey: "wrong" });
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
