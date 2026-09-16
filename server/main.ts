import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createApp } from "./app.ts";
import { secret } from "./infrastructure/security.ts";
import { z } from "zod";

const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT 必须是 1–65535 的整数。");
const databasePath = resolve(
  process.env.DAILY_DATABASE_PATH ?? "data/daily-flow.sqlite",
);
mkdirSync(dirname(databasePath), { recursive: true });
const setupKey = process.env.DAILY_SETUP_KEY ?? secret();
const service = await createApp({
  databasePath,
  setupKey,
  staticDirectory: resolve("dist"),
});
try {
  await service.listen(port);
  const origin = `http://127.0.0.1:${port}`;
  console.log(`日序已启动：${origin}`);
  const status = z
    .object({ needsSetup: z.boolean() })
    .parse(
      await fetch(`${origin}/api/setup/status`).then((response) =>
        response.json(),
      ),
    );
  if (status.needsSetup)
    console.log(`首次创建团队（仅本机使用）：${origin}/setup#key=${setupKey}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "启动失败。");
  await service.close();
  process.exitCode = 1;
}
async function shutdown() {
  await service.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
