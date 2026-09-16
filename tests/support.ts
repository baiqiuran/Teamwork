import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { createApp } from "../server/app.ts";

export async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "daily-journal-"));
  let time = Date.parse("2026-09-16T15:59:00Z");
  const databasePath = join(directory, "test.sqlite");
  let service: ReturnType<typeof createApp>;
  let server: ReturnType<typeof service.app.listen>;
  let origin = "";
  async function start() {
    service = createApp({
      databasePath,
      setupKey: "test-key",
      now: () => time,
    });
    server = service.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    service.close();
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  function client() {
    let cookie = "";
    return async (
      path: string,
      body?: unknown,
      method = body === undefined ? "GET" : "POST",
    ) => {
      const response = await fetch(`${origin}/api${path}`, {
        method,
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.get("set-cookie"))
        cookie = response.headers.get("set-cookie")!.split(";")[0];
      return { status: response.status, data: await response.json() };
    };
  }
  const author = client();
  const credentials = {
    name: "林晓",
    email: "lin@example.test",
    password: "QuietRiver2026!",
    teamName: "团队",
    setupKey: "test-key",
  };
  const identity = (await author("/setup", credentials)).data;
  const guest = client();
  const invitation = (await author("/invitations", {})).data;
  const colleague = client();
  const other = (
    await colleague("/join", {
      name: "周宁",
      email: "zhou@example.test",
      password: "QuietRiver2026!",
      token: invitation.token,
    })
  ).data;
  return {
    author,
    colleague,
    guest,
    identity,
    other,
    client,
    setTime: (value: string) => {
      time = Date.parse(value);
    },
    restart: async () => {
      await stop();
      await start();
    },
    credentials,
  };
}
