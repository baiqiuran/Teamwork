import { spawn, spawnSync } from "node:child_process";

// Compile decorators before Node executes them; Vite remains a separate build.
const compiler = "node_modules/typescript/bin/tsc";
const first = spawnSync(process.execPath, ["scripts/build-server.mjs"], {
  stdio: "inherit",
  windowsHide: true,
});
if (first.status !== 0) process.exit(first.status ?? 1);
const children = [
  spawn(
    process.execPath,
    [
      compiler,
      "-p",
      "tsconfig.server.json",
      "--watch",
      "--preserveWatchOutput",
    ],
    { stdio: "inherit", windowsHide: true },
  ),
  spawn(process.execPath, ["--watch", "build/server/main.js"], {
    stdio: "inherit",
    windowsHide: true,
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const child of children) {
  child.once("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.once("exit", (code) => stop(code ?? 0));
}
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
