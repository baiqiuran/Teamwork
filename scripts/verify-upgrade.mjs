import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile, rm, cp } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const inputs = process.argv.slice(2);
for (let index = 0; index < inputs.length; index += 2) {
  assert.ok(
    ["--from-runtime", "--candidate-runtime"].includes(inputs[index]) &&
      inputs[index + 1],
    "Unknown or incomplete upgrade option",
  );
  assert.equal(
    inputs.indexOf(inputs[index]),
    index,
    "Duplicate upgrade option",
  );
}
const option = (name) => {
  const index = inputs.indexOf(name);
  return index < 0 ? undefined : inputs[index + 1];
};
const oldRuntime = option("--from-runtime");
const candidateRuntime = option("--candidate-runtime");
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = resolve(app, "build");
await mkdir(build, { recursive: true });
const directory = await mkdtemp(resolve(build, "upgrade-"));
const legacy = resolve(directory, "legacy");
const require = createRequire(resolve(app, "package.json"));
const baseline = "4414749e79ea16e5e1c7c6b7117a0696771d6fbe";
let running;
let cookie = "";
let port = 0;
let accessToken;
let refreshToken;
const options = {
  databasePath: resolve(directory, "test.sqlite"),
  setupKey: "upgrade-test-key",
  now: () => Date.parse("2026-09-16T03:00:00Z"),
};

async function start(factory) {
  const service = await factory(options);
  let server;
  if (service.listen) server = await service.listen(port);
  else {
    server = service.app.listen(port, "127.0.0.1");
    await new Promise((ready, reject) => {
      server.once("listening", ready);
      server.once("error", reject);
    });
  }
  port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    async protocol(path, body, token) {
      const response = await fetch(origin + path, {
        method: "POST",
        headers:
          body instanceof URLSearchParams
            ? {}
            : {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
        body: body instanceof URLSearchParams ? body : JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    },
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
  if (!oldRuntime) {
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
  }
  const old = await import(
    pathToFileURL(
      oldRuntime
        ? resolve(oldRuntime, "build/server/app.js")
        : resolve(legacy, "server/app.ts"),
    ).href
  );
  const modern = await import(
    pathToFileURL(
      candidateRuntime
        ? resolve(candidateRuntime, "build/server/app.js")
        : resolve(build, "server/app.js"),
    ).href
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
  if (oldRuntime) {
    const verifier = "a".repeat(43);
    const request = {
      client_id: "daily-flow-codex",
      redirect_uri: "http://127.0.0.1:19999/callback",
      resource: `${running.origin}/mcp`,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      scope: "progress:read",
      state: "upgrade-fixture",
    };
    const approval = await running.request(
      "/ai/authorize",
      { request, scopes: ["progress:read"], approve: true },
      201,
    );
    const token = await running.protocol(
      "/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: request.client_id,
        redirect_uri: request.redirect_uri,
        resource: request.resource,
        code: new URL(approval.redirect).searchParams.get("code"),
        code_verifier: verifier,
      }),
    );
    accessToken = token.access_token;
    refreshToken = token.refresh_token;
  }
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

  const backup = resolve(directory, "backup");
  await mkdir(backup);
  await cp(options.databasePath, resolve(backup, "test.sqlite"));
  await cp(resolve(directory, "attachments"), resolve(backup, "attachments"), {
    recursive: true,
  });
  const beforeMigration = databaseSnapshot(options.databasePath);
  running = await start(modern.createApp);
  assertPreserved(beforeMigration, databaseSnapshot(options.databasePath));
  if (accessToken) {
    const result = await running.protocol(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_context", arguments: {} },
      },
      accessToken,
    );
    assert.equal(result.result.structuredContent.member.id, identity.member.id);
    assert.ok(
      (
        await running.protocol(
          "/oauth/token",
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: "daily-flow-codex",
            resource: `${running.origin}/mcp`,
            refresh_token: refreshToken,
          }),
        )
      ).access_token,
    );
  }
  assert.deepEqual(
    await running.request("/me"),
    identity,
    "old session survives without logging in again",
  );
  for (let i = 0; i < paths.length; i++) {
    const actual = await running.request(paths[i]);
    if (paths[i].endsWith("/events") && !oldRuntime) {
      assert.ok(
        actual.every(
          (event) => event.kind === "diary" && event.channel === "web",
        ),
      );
      assert.deepEqual(
        actual.map(({ kind, channel, ...event }) => event),
        snapshots[i],
        paths[i],
      );
    } else assert.deepEqual(actual, snapshots[i], paths[i]);
  }
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

  // Restore a matched, stopped backup. Old binaries must not write the upgraded event schema.
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = resolve(options.databasePath + suffix);
    assert.ok(target.startsWith(directory + sep));
    await rm(target, { force: true });
  }
  await cp(resolve(backup, "test.sqlite"), options.databasePath);
  await rm(resolve(directory, "attachments"), { recursive: true, force: true });
  await cp(resolve(backup, "attachments"), resolve(directory, "attachments"), {
    recursive: true,
  });
  running = await start(old.createApp);
  if (accessToken) {
    const result = await running.protocol(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_context", arguments: {} },
      },
      accessToken,
    );
    assert.equal(result.result.structuredContent.member.id, identity.member.id);
  }
  assert.deepEqual(await running.request("/me"), identity);
  for (let i = 0; i < paths.length; i++)
    assert.deepEqual(
      await running.request(paths[i]),
      snapshots[i],
      `rollback ${paths[i]}`,
    );
  assert.deepEqual(await running.request(`/diaries/${diary.id}`), draft);
  assert.equal(
    (await running.request("/members")).some(
      (member) => member.id === joined.member.id,
    ),
    false,
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
    "Upgrade and backup restore passed: old sessions, accounts, invitation, private drafts, submission receipts, event migration, public links and attachments preserved; restoring the old backup intentionally discards new writes.",
  );
} finally {
  if (running) await running.stop();
  const checked = resolve(directory);
  if (!checked.startsWith(build + sep))
    throw new Error("Unexpected temporary directory");
  await rm(checked, { recursive: true, force: true });
}

// Compare stored rows before migration to catch destructive behavior that metadata can hide.
function databaseSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    return db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map(({ name }) => {
        const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
        const columns = db
          .prepare(`PRAGMA table_info(${quote(name)})`)
          .all()
          .map((column) => column.name);
        return {
          name,
          columns,
          rows: db
            .prepare(
              `SELECT ${columns.map(quote).join(",")} FROM ${quote(name)}`,
            )
            .all(),
        };
      });
  } finally {
    db.close();
  }
}
function assertPreserved(before, after) {
  for (const table of before) {
    const migrated = after.find((item) => item.name === table.name);
    assert.ok(migrated, `DESTRUCTIVE_MIGRATION: table ${table.name} removed`);
    for (const column of table.columns)
      assert.ok(
        migrated.columns.includes(column),
        `DESTRUCTIVE_MIGRATION: ${table.name}.${column} removed`,
      );
    const rows = migrated.rows.map((row) =>
      JSON.stringify(table.columns.map((column) => row[column])),
    );
    for (const row of table.rows) {
      const index = rows.indexOf(
        JSON.stringify(table.columns.map((column) => row[column])),
      );
      assert.ok(
        index >= 0,
        `DESTRUCTIVE_MIGRATION: stored row changed in ${table.name}`,
      );
      rows.splice(index, 1);
    }
  }
}
