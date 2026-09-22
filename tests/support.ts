import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createServer } from "node:net";
import { createApp } from "./application.ts";

export async function applicationFixture(
  t: Pick<TestContext, "after">,
  options: Partial<Parameters<typeof createApp>[0]> = {},
  prepare?: (databasePath: string, origin: string) => Promise<void> | void,
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
    await service?.close();
  }
  t.after(async () => {
    try {
      await stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  if (prepare) {
    // Historical OAuth credentials are resource-bound before the first startup.
    const reservation = createServer();
    try {
      await new Promise<void>((ready, reject) => {
        reservation.once("error", reject);
        reservation.listen(0, "127.0.0.1", ready);
      });
      const address = reservation.address();
      if (!address || typeof address === "string")
        throw new Error("No address");
      origin = `http://127.0.0.1:${address.port}`;
      await prepare(databasePath, origin);
    } finally {
      await new Promise<void>((done) => reservation.close(() => done()));
    }
  }
  await start();
  function client(cookie = "") {
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
  return {
    databasePath,
    get origin() {
      return origin;
    },
    client,
    stop,
    start,
    setTime: (value: string) => {
      time = Date.parse(value);
    },
    restart: async () => {
      await stop();
      await start();
    },
  };
}

export async function fixture(
  t: TestContext,
  options: Partial<Parameters<typeof createApp>[0]> = {},
) {
  const f = await applicationFixture(t, options);
  const { client } = f;
  const author = client();
  const credentials = {
    name: "林晓",
    email: "lin@example.test",
    password: "QuietRiver2026!",
    teamName: "团队",
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
    ...f,
    get origin() {
      return f.origin;
    },
    author,
    colleague,
    guest,
    identity,
    other,
    credentials,
  };
}
