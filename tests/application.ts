import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Exercise the same compiled backend that production runs, including decorators.
const backend: typeof import("../server/app.ts") = await import(
  pathToFileURL(resolve("build/server/app.js")).href
);
export const createApp = backend.createApp;
