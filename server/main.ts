import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import express from "express";
import { createApp } from "./app.ts";
import { secret } from "./security.ts";

const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT 必须是 1–65535 的整数。");
const databasePath = resolve(
  process.env.DAILY_DATABASE_PATH ?? "data/daily-flow.sqlite",
);
mkdirSync(dirname(databasePath), { recursive: true });
const setupKey = process.env.DAILY_SETUP_KEY ?? secret();
const service = createApp({ databasePath, setupKey });
const dist = resolve("dist");
service.app.use(express.static(dist, { index: false }));
service.app.get("/{*path}", (_request, response) => {
  if (!existsSync(resolve(dist, "index.html"))) {
    response.status(503).send("请先运行 npm run build。");
    return;
  }
  response
    .set("Cache-Control", "no-store")
    .sendFile(resolve(dist, "index.html"));
});
const server = service.app.listen(port, "127.0.0.1", async () => {
  const origin = `http://127.0.0.1:${port}`;
  console.log(`日序已启动：${origin}`);
  const status = await fetch(`${origin}/api/setup/status`).then((response) =>
    response.json(),
  );
  if (status.needsSetup)
    console.log(`首次创建团队（仅本机使用）：${origin}/setup#key=${setupKey}`);
});
server.on("error", (error) => {
  console.error(error.message);
  service.close();
  process.exitCode = 1;
});
function shutdown() {
  server.close(() => {
    service.close();
    process.exit(0);
  });
  server.closeAllConnections();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
