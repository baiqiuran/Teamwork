import { dirname, resolve } from "node:path";

// Official Node distributions put npm next to node on Windows and in ../lib on Linux.
export const npmCli =
  process.env.npm_execpath ??
  resolve(
    dirname(process.execPath),
    ...(process.platform === "win32" ? [] : ["..", "lib"]),
    "node_modules/npm/bin/npm-cli.js",
  );
