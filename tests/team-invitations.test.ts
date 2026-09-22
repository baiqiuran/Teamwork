import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./support.ts";

const secondAccount = {
  name: "第二队成员",
  email: "second-team@example.test",
  password: "SecondTeam2026!",
  teamName: "第二团队",
};
const newcomer = {
  name: "受邀成员",
  email: "invited@example.test",
  password: "InvitedMember2026!",
};

test("邀请按生成者团队预览和加入，账号冲突不消费邀请且本人管理不扩展到团队", async (t) => {
  const f = await fixture(t);
  const second = f.client();
  const identity = await second("/setup", secondAccount);
  assert.equal(identity.status, 201);
  const invite = await second("/invitations", {
    teamId: f.identity.team.id,
    createdBy: f.identity.member.id,
  });
  assert.equal(invite.status, 201);
  assert.equal(invite.data.joinPath, `/join#invite=${invite.data.token}`);
  const preview = await f.guest("/invitations/preview", {
    token: invite.data.token,
    teamId: f.identity.team.id,
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.data, {
    team: identity.data.team,
    invitedBy: secondAccount.name,
    expiresAt: Date.parse("2026-09-23T15:59:00Z"),
  });
  const emailConflict = await f.author("/join", {
    ...f.credentials,
    token: invite.data.token,
  });
  assert.equal(emailConflict.status, 409);
  assert.equal(emailConflict.data.error, "此邮箱已注册，请直接登录。");
  assert.equal(emailConflict.headers.get("set-cookie"), null);
  assert.deepEqual((await f.author("/me")).data, f.identity);
  const visitor = f.client();
  assert.equal(
    (
      await visitor("/join", {
        ...newcomer,
        password: "short",
        token: invite.data.token,
      })
    ).status,
    400,
  );
  assert.equal((await visitor("/me")).status, 401);
  assert.deepEqual(
    (await visitor("/invitations/preview", { token: invite.data.token })).data,
    preview.data,
  );
  const joined = await visitor("/join", {
    ...newcomer,
    token: invite.data.token,
    teamId: f.identity.team.id,
    teamName: f.identity.team.name,
    memberId: f.identity.member.id,
  });
  assert.equal(joined.status, 201);
  assert.deepEqual(joined.data.team, identity.data.team);
  assert.equal(joined.data.member.teamId, identity.data.team.id);
  assert.notEqual(joined.data.member.id, f.identity.member.id);
  assert.equal(
    (await f.guest("/invitations/preview", { token: invite.data.token }))
      .status,
    410,
  );

  const ownInvite = await visitor("/invitations", {});
  const ownerInvite = await second("/invitations", {});
  const before = (await second("/invitations")).data;
  for (const [client, status, error] of [
    [f.author, 404, "未找到邀请。"],
    [f.colleague, 404, "未找到邀请。"],
    [visitor, 403, "只能撤销自己生成的邀请。"],
  ] as const) {
    const forbidden = await client(
      `/invitations/${ownerInvite.data.invitation.id}/revoke`,
      { teamId: identity.data.team.id },
    );
    assert.equal(forbidden.status, status, JSON.stringify(forbidden.data));
    assert.deepEqual(forbidden.data, { error });
    const listed = await client(
      `/invitations?teamId=${identity.data.team.id}&memberId=${identity.data.member.id}`,
    );
    assert.equal(listed.status, 200);
    assert.ok(
      listed.data.invitations.every(
        (item: { id: string }) => item.id !== ownerInvite.data.invitation.id,
      ),
    );
  }
  assert.deepEqual((await second("/invitations")).data, before);
  assert.equal(
    (await f.guest("/invitations/preview", { token: ownerInvite.data.token }))
      .status,
    200,
  );
  assert.equal(
    (await visitor(`/invitations/${ownInvite.data.invitation.id}/revoke`, {}))
      .status,
    200,
  );
  assert.equal(
    (await second(`/invitations/${ownerInvite.data.invitation.id}/revoke`, {}))
      .status,
    200,
  );
  assert.equal(
    (await f.guest("/invitations/preview", { token: ownerInvite.data.token }))
      .status,
    410,
  );
  await f.restart();
  assert.deepEqual((await visitor("/me")).data, joined.data);
  assert.deepEqual((await second("/me")).data, identity.data);
  assert.equal(
    (await f.guest("/invitations/preview", { token: invite.data.token }))
      .status,
    410,
  );
  const owned = (await second("/invitations")).data.invitations;
  assert.deepEqual(
    owned.map((item: { status: string }) => item.status),
    ["revoked", "used"],
  );
  assert.ok(
    owned.every(
      (item: { createdBy: string; token?: string }) =>
        item.createdBy === identity.data.member.id && !item.token,
    ),
  );
});

test("第二团队同一邀请并发接受只创建一人，失败方无会话且重启后仍为已使用", async (t) => {
  const f = await fixture(t);
  const second = f.client();
  const identity = (await second("/setup", secondAccount)).data;
  const invite = (await second("/invitations", {})).data;
  const clients = [f.client(), f.client()];
  const inputs = clients.map((_, i) => ({
    ...newcomer,
    email: `race${i}@example.test`,
    token: invite.token,
  }));
  const results = await Promise.all(
    clients.map((client, i) => client("/join", inputs[i])),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 410]);
  const winner = results.findIndex((result) => result.status === 201),
    loser = 1 - winner;
  assert.deepEqual(results[winner].data.team, identity.team);
  assert.deepEqual((await clients[winner]("/me")).data, results[winner].data);
  assert.equal(results[loser].headers.get("set-cookie"), null);
  assert.equal((await clients[loser]("/me")).status, 401);
  assert.equal((await clients[loser]("/login", inputs[loser])).status, 401);
  const fresh = (await second("/invitations", {})).data;
  assert.equal(
    (await clients[loser]("/join", { ...inputs[loser], token: fresh.token }))
      .status,
    201,
  );
  await f.restart();
  assert.equal(
    (await f.guest("/invitations/preview", { token: invite.token })).status,
    410,
  );
  assert.deepEqual((await clients[winner]("/me")).data, results[winner].data);
});

test("第二团队邀请恰满七天及撤销伪造时不能加入，过期不重置原成员归属", async (t) => {
  const f = await fixture(t);
  const second = f.client();
  const identity = (await second("/setup", secondAccount)).data;
  const expiring = (await second("/invitations", {})).data;
  const revoked = (await second("/invitations", {})).data;
  assert.equal(
    (await second(`/invitations/${revoked.invitation.id}/revoke`, {})).status,
    200,
  );
  f.setTime("2026-09-23T15:58:59.999Z");
  assert.equal(
    (await f.guest("/invitations/preview", { token: expiring.token })).status,
    200,
  );
  f.setTime("2026-09-23T15:59:00Z");
  for (const token of [expiring.token, revoked.token, "forged-invitation"]) {
    const visitor = f.client();
    assert.equal(
      (await visitor("/invitations/preview", { token })).status,
      410,
    );
    const failed = await visitor("/join", { ...newcomer, token });
    assert.equal(failed.status, 410);
    assert.equal(failed.headers.get("set-cookie"), null);
    assert.equal((await visitor("/me")).status, 401);
    assert.equal((await visitor("/login", newcomer)).status, 401);
  }
  assert.equal((await second("/me")).status, 401);
  assert.equal((await second("/login", secondAccount)).status, 200);
  assert.deepEqual((await second("/me")).data, identity);
  const fresh = (await second("/invitations", {})).data;
  const joined = await f.client()("/join", { ...newcomer, token: fresh.token });
  assert.equal(joined.status, 201);
  assert.deepEqual(joined.data.team, identity.team);
  await f.restart();
  const invitations = (await second("/invitations")).data.invitations;
  assert.deepEqual(
    invitations.map((item: { status: string }) => item.status),
    ["used", "revoked", "expired"],
  );
});
