import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { applicationFixture } from "./support.ts";

const authorJoinedAt = Date.parse("2026-09-15T02:00:00Z");
const colleagueJoinedAt = Date.parse("2026-09-16T02:00:00Z");

async function teams(t: TestContext) {
  const f = await applicationFixture(t);
  const author = f.client(),
    colleague = f.client(),
    foreign = f.client(),
    guest = f.client();
  f.setTime("2026-09-15T02:00:00Z");
  const own = await author("/setup", {
    teamName: "青山团队",
    name: "林晓",
    email: "lin@example.test",
    password: "RosterRiver2026!",
  });
  const invitation = await author("/invitations", {});
  f.setTime("2026-09-16T02:00:00Z");
  const other = await colleague("/join", {
    token: invitation.data.token,
    name: "周宁",
    email: "zhou@example.test",
    password: "RosterRiver2026!",
  });
  const outside = await foreign("/setup", {
    teamName: "蓝海团队",
    name: "蓝海成员",
    email: "blue@example.test",
    password: "RosterRiver2026!",
  });
  assert.deepEqual(
    [own.status, invitation.status, other.status, outside.status],
    [201, 201, 201, 201],
  );
  const roster = async (client: typeof author, query = "") => {
    const response = await client(`/members${query}`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data as {
      id: string;
      name: string;
      joinedAt: number;
      lastDiaryDate: string | null;
    }[];
  };
  const member = async (client: typeof author, name: string, query = "") =>
    (await roster(client, query)).find((row) => row.name === name);
  return {
    ...f,
    author,
    colleague,
    foreign,
    guest,
    roster,
    member,
    own: own.data,
    other: other.data,
    outside: outside.data,
  };
}

async function submit(
  client: Awaited<ReturnType<typeof teams>>["author"],
  body: string,
) {
  const created = await client("/diaries", {
    title: "名单日期",
    entries: [{ id: randomUUID(), body }],
  });
  assert.equal(created.status, 201);
  const result = await client(`/diaries/${created.data.id}/submit`, {
    version: 1,
    requestId: randomUUID(),
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}

test("成员名单显示本团队姓名、加入日期与最近提交日期，草稿不计入且不含账号隐私", async (t) => {
  const f = await teams(t);
  // Existing name ordering is kept, and both the creator and the invited member appear.
  assert.deepEqual(await f.roster(f.author), [
    {
      id: f.other.member.id,
      name: "周宁",
      joinedAt: colleagueJoinedAt,
      lastDiaryDate: null,
    },
    {
      id: f.own.member.id,
      name: "林晓",
      joinedAt: authorJoinedAt,
      lastDiaryDate: null,
    },
  ]);
  const draftEntry = { id: randomUUID(), body: "周宁仅保存草稿" };
  const draft = await f.colleague("/diaries", {
    title: "未提交",
    entries: [draftEntry],
  });
  assert.equal(draft.status, 201);
  const uploaded = await f.colleague(
    `/diaries/${draft.data.id}/entries/${draftEntry.id}/attachments`,
    {
      version: draft.data.version,
      requestId: randomUUID(),
      name: "草稿附件.txt",
      base64: Buffer.from("草稿字节").toString("base64"),
    },
  );
  assert.equal(uploaded.status, 201);
  assert.equal((await f.member(f.author, "周宁"))?.lastDiaryDate, null);
  f.setTime("2026-09-16T02:00:00Z");
  const first = await submit(f.author, "九月十六的工作");
  assert.equal(first.diaryDate, "2026-09-16");
  assert.equal((await f.member(f.author, "林晓"))?.lastDiaryDate, "2026-09-16");
  // 同日修改并再次提交只更新同一份日报，最近提交日期不因此改变。
  const revised = await f.author(`/diaries/${first.id}/save`, {
    title: "名单日期",
    entries: [{ id: randomUUID(), body: "九月十六的工作已修订" }],
    version: first.version,
  });
  assert.equal(revised.status, 200, JSON.stringify(revised.data));
  const resubmitted = await f.author(`/diaries/${first.id}/submit`, {
    version: revised.data.version,
    requestId: randomUUID(),
  });
  assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.data));
  assert.equal(resubmitted.data.diaryDate, "2026-09-16");
  assert.equal((await f.member(f.author, "林晓"))?.lastDiaryDate, "2026-09-16");
  f.setTime("2026-09-17T16:01:00Z");
  const second = await submit(f.author, "跨日后提交的工作");
  assert.equal(second.diaryDate, "2026-09-18");
  const colleagueDiary = await submit(f.colleague, "周宁首次提交");
  assert.deepEqual(
    (await f.roster(f.author)).map((row) => [row.name, row.lastDiaryDate]),
    [
      ["周宁", "2026-09-18"],
      ["林晓", "2026-09-18"],
    ],
  );
  const deleted = await f.author(`/diaries/${second.id}/delete`, {
    version: second.version,
  });
  assert.equal(deleted.status, 200);
  assert.equal((await f.member(f.author, "林晓"))?.lastDiaryDate, "2026-09-16");
  assert.equal(
    (await f.member(f.colleague, "周宁"))?.lastDiaryDate,
    "2026-09-18",
  );
  assert.deepEqual(
    await f.roster(f.author, `?teamId=99&memberId=${f.outside.member.id}`),
    await f.roster(f.author),
  );
  assert.equal((await f.guest("/members")).status, 401);
  assert.deepEqual(await f.roster(f.foreign), [
    {
      id: f.outside.member.id,
      name: "蓝海成员",
      joinedAt: colleagueJoinedAt,
      lastDiaryDate: null,
    },
  ]);
  const text = JSON.stringify(await f.roster(f.author));
  for (const secret of [
    "lin@example.test",
    "zhou@example.test",
    "blue@example.test",
    "RosterRiver2026",
    f.outside.member.id,
  ])
    assert.doesNotMatch(
      text,
      new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    );
  assert.ok(!text.includes(colleagueDiary.published.entries[0].body));
  await f.restart();
  assert.deepEqual(await f.roster(f.author), [
    {
      id: f.other.member.id,
      name: "周宁",
      joinedAt: colleagueJoinedAt,
      lastDiaryDate: "2026-09-18",
    },
    {
      id: f.own.member.id,
      name: "林晓",
      joinedAt: authorJoinedAt,
      lastDiaryDate: "2026-09-16",
    },
  ]);
});
