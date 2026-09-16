import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = resolve(app, "build");
await mkdir(build, { recursive: true });
const directory = await mkdtemp(resolve(build, "upgrade-"));
const legacy = resolve(directory, "legacy");
const require = createRequire(resolve(app, "package.json"));
const baseline = "4414749e79ea16e5e1c7c6b7117a0696771d6fbe";
let running;
let cookie = "";
const options = {
  databasePath: resolve(directory, "test.sqlite"),
  setupKey: "upgrade-test-key",
  now: () => Date.parse("2026-09-16T03:00:00Z"),
};

async function start(factory) {
  const service = await factory(options);
  let server;
  if (service.listen) server = await service.listen(0);
  else {
    server = service.app.listen(0, "127.0.0.1");
    await new Promise((ready, reject) => {
      server.once("listening", ready);
      server.once("error", reject);
    });
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    async request(path, body, expected = 200, anonymous = false, raw = false) {
      const response = await fetch(`${origin}/api${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Cookie: anonymous ? "" : cookie,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = raw ? await response.text() : await response.json();
      assert.equal(
        response.status,
        expected,
        `${path}: ${JSON.stringify(result)}`,
      );
      if (!anonymous && response.headers.get("set-cookie"))
        cookie = response.headers.get("set-cookie").split(";")[0];
      return result;
    },
    async stop() {
      if (!service.listen) {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
      await service.close();
    },
  };
}

try {
  const names = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", baseline, "server"],
    { cwd: app, encoding: "utf8", windowsHide: true },
  )
    .trim()
    .split(/\r?\n/)
    .filter((name) => name.endsWith(".ts") && !name.endsWith("main.ts"));
  for (const name of names) {
    const source = execFileSync("git", ["show", `${baseline}:${name}`], {
      cwd: app,
      encoding: "utf8",
      windowsHide: true,
    });
    const rewritten = source.replace(
      /from\s+"([^".][^"]*)"/g,
      (all, specifier) =>
        specifier.startsWith("node:")
          ? all
          : `from "${pathToFileURL(require.resolve(specifier)).href}"`,
    );
    const target = resolve(legacy, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, rewritten);
  }
  await writeFile(
    resolve(legacy, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  const old = await import(
    pathToFileURL(resolve(legacy, "server/app.ts")).href
  );
  const modern = await import(
    pathToFileURL(resolve(build, "server/app.js")).href
  );
  running = await start(old.createApp);
  const credentials = {
    name: "兼容成员",
    email: "upgrade@example.test",
    password: "UpgradeFixture2026!",
  };
  const identity = await running.request(
    "/setup",
    { ...credentials, teamName: "兼容团队", setupKey: options.setupKey },
    201,
  );
  const invitation = await running.request("/invitations", {}, 201);
  const project = await running.request(
    "/projects",
    { name: "旧项目", description: "迁移前建立" },
    201,
  );
  const task = await running.request(
    `/projects/${project.id}/tasks`,
    { name: "旧任务", description: "保留版本" },
    201,
  );
  const entryId = randomUUID();
  let diary = await running.request(
    "/diaries",
    {
      title: "旧日报",
      entries: [
        {
          id: entryId,
          body: "迁移前的进展",
          projectId: project.id,
          taskId: task.id,
          statusChange: {
            status: "in-progress",
            expectedVersion: task.version,
          },
        },
        { id: randomUUID(), body: "临时工作" },
      ],
    },
    201,
  );
  diary = await running.request(
    `/diaries/${diary.id}/entries/${entryId}/attachments`,
    {
      version: diary.version,
      requestId: randomUUID(),
      name: "兼容.txt",
      base64: Buffer.from("upgrade attachment").toString("base64"),
    },
    201,
  );
  const input = { version: diary.version, requestId: randomUUID() };
  const published = await running.request(`/diaries/${diary.id}/submit`, input);
  const attachmentId = published.published.entries[0].attachments[0].id;
  const paths = [
    "/team-diaries",
    `/projects/${project.id}/progress`,
    `/tasks/${task.id}`,
    `/tasks/${task.id}/events`,
    "/diary-events",
  ];
  const shares = [];
  for (const [type, targetId] of [
    ["diary", undefined],
    ["project", project.id],
    ["task", task.id],
  ]) {
    const share = await running.request(
      "/shares",
      {
        type,
        targetId,
        from: "2026-09-16",
        to: "2026-09-16",
        modules: ["overview", "tasks", "progress"],
      },
      201,
    );
    shares.push(share);
    paths.push(`/public/${share.token}`);
  }
  const snapshots = await Promise.all(
    paths.map((path) => running.request(path)),
  );
  const draft = await running.request(`/diaries/${diary.id}/save`, {
    ...published.draft,
    title: "私人待重提修改",
    version: published.version,
  });
  const privateDraft = await running.request(
    "/diaries",
    {
      title: "未提交草稿",
      entries: [{ id: randomUUID(), body: "保留私人草稿" }],
    },
    201,
  );
  await running.stop();
  running = undefined;

  running = await start(modern.createApp);
  assert.deepEqual(
    await running.request("/me"),
    identity,
    "old session survives without logging in again",
  );
  for (let i = 0; i < paths.length; i++)
    assert.deepEqual(await running.request(paths[i]), snapshots[i], paths[i]);
  assert.deepEqual(await running.request(`/diaries/${diary.id}`), draft);
  assert.deepEqual(
    await running.request(`/diaries/${privateDraft.id}`),
    privateDraft,
  );
  assert.deepEqual(
    await running.request(`/diaries/${diary.id}/submit`, input),
    published,
  );
  assert.equal(
    await running.request(
      `/public/${shares[0].token}/attachments/${attachmentId}`,
      undefined,
      200,
      true,
      true,
    ),
    "upgrade attachment",
  );
  await running.request(
    "/invitations/preview",
    { token: invitation.token },
    200,
    true,
  );
  const joined = await running.request(
    "/join",
    {
      token: invitation.token,
      name: "迁移后成员",
      email: "joined@example.test",
      password: "JoinedMember2026!",
    },
    201,
    true,
  );
  const resubmitted = await running.request(`/diaries/${diary.id}/submit`, {
    version: draft.version,
    requestId: randomUUID(),
  });
  const updated = await Promise.all(paths.map((path) => running.request(path)));
  await running.stop();
  running = undefined;

  running = await start(old.createApp);
  assert.deepEqual(await running.request("/me"), identity);
  for (let i = 0; i < paths.length; i++)
    assert.deepEqual(
      await running.request(paths[i]),
      updated[i],
      `rollback ${paths[i]}`,
    );
  assert.deepEqual(await running.request(`/diaries/${diary.id}`), resubmitted);
  assert.equal(
    (await running.request("/members")).some(
      (member) => member.id === joined.member.id,
    ),
    true,
  );
  assert.equal(
    await running.request(
      `/attachments/${attachmentId}`,
      undefined,
      200,
      false,
      true,
    ),
    "upgrade attachment",
  );
  await running.request("/logout", {});
  await running.request("/login", credentials);
  console.log(
    "Upgrade and rollback passed: existing session, credentials, invitation, private drafts, submission receipt, task history, three public links, attachments, new writes and baseline reads.",
  );
} finally {
  if (running) await running.stop();
  const checked = resolve(directory);
  if (!checked.startsWith(build + sep))
    throw new Error("Unexpected temporary directory");
  await rm(checked, { recursive: true, force: true });
}
