import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createApp } from "./application.ts";

export async function fixture(
  t: TestContext,
  options: Partial<Parameters<typeof createApp>[0]> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "daily-journal-"));
  let time = Date.parse("2026-09-16T15:59:00Z");
  const databasePath = join(directory, "test.sqlite");
  let service: Awaited<ReturnType<typeof createApp>>;
  let server: Awaited<ReturnType<typeof service.listen>>;
  let origin = "";
  async function start() {
    service = await createApp({
      ...options,
      databasePath,
      setupKey: "test-key",
      now: () => time,
    });
    server = await service.listen(
      origin ? Number(new URL(origin).port) : 0,
      "127.0.0.1",
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function stop() {
    await service.close();
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
          Connection: "close",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.get("set-cookie"))
        cookie = response.headers.get("set-cookie")!.split(";")[0];
      return {
        status: response.status,
        headers: response.headers,
        data: response.headers.get("content-type")?.includes("application/json")
          ? await response.json()
          : await response.text(),
      };
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
    get origin() {
      return origin;
    },
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
