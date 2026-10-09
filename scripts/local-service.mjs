import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processIdentity, listenerPids, writeJson } from "./local-process.mjs";
const [action, ...args] = process.argv.slice(2);
if (!["start", "dev", "status"].includes(action))
  throw Error(
    "Usage: local-service.mjs start|dev|status [--port N] [--public-url URL]",
  );
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const port = Number(option("--port") ?? process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("PORT must be between 1 and 65535");
const directory = resolve(
  process.env.DAILY_LOCAL_RUN_DIR ?? ".local-run",
  String(port),
);
const read = (name) => {
  try {
    return JSON.parse(readFileSync(resolve(directory, name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
async function probe(origin) {
  try {
    const response = await fetch(new URL("/health/ready", origin), {
      signal: AbortSignal.timeout(2000),
    });
    const health = await response.json();
    return {
      url: origin,
      status: response.status,
      ready: response.ok && health.ready === true,
      version: health.version,
    };
  } catch (error) {
    return { url: origin, ready: false, error: error.message };
  }
}
async function localStatus() {
  const latest = read("latest.json");
  const service = read("service.json");
  const current = service?.runId === latest?.runId ? service : null;
  const owner = listenerPids(port);
  const actual = current ? processIdentity(current.pid) : null;
  const launcherAlive =
    latest && processIdentity(latest.pid) === latest.processIdentity;
  const details = {
    address: `http://127.0.0.1:${port}`,
    pid: current?.pid ?? null,
    startedAt: current?.startedAt ?? latest?.startedAt ?? null,
    logs: latest?.logs ?? null,
    listenerPids: owner,
  };
  if (current && actual && actual !== current.processIdentity)
    return { ...details, state: "pid-reused" };
  if (
    owner.length &&
    (!current || !actual || owner.some((pid) => pid !== current.pid))
  )
    return { ...details, state: "port-occupied" };
  if (current && actual && owner.includes(current.pid)) {
    const health = await probe(details.address);
    return {
      ...details,
      state: health.ready ? "running" : "not-ready",
      health,
    };
  }
  if (actual || launcherAlive) return { ...details, state: "starting" };
  return { ...details, state: latest ? "exited" : "not-started" };
}
if (action === "status") {
  const result = { local: await localStatus() };
  const publicUrl = option("--public-url");
  if (publicUrl) {
    const parsed = new URL(publicUrl);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw Error("Public URL must be HTTP(S) without credentials");
    result.public = await probe(parsed.origin);
  }
  console.log(JSON.stringify(result, null, 2));
} else {
  const previous = await localStatus();
  if (
    !["not-started", "exited", "pid-reused"].includes(previous.state) ||
    previous.listenerPids.length
  )
    throw Error(
      `Port ${port}: ${previous.state}; inspect npm run status first`,
    );
  mkdirSync(directory, { recursive: true });
  const runId = randomUUID();
  const logs = {
    stdout: resolve(directory, `${runId}.stdout.log`),
    stderr: resolve(directory, `${runId}.stderr.log`),
  };
  writeJson(resolve(directory, "latest.json"), {
    runId,
    pid: process.pid,
    processIdentity: processIdentity(process.pid),
    startedAt: new Date().toISOString(),
    address: `http://127.0.0.1:${port}`,
    mode: action,
    logs,
  });
  console.log(
    `Local launcher PID: ${process.pid}\nAddress: http://127.0.0.1:${port}\nstdout: ${logs.stdout}\nstderr: ${logs.stderr}`,
  );
  const observer = new URL("./local-observer.mjs", import.meta.url).href;
  const env = {
    ...process.env,
    PORT: String(port),
    DAILY_LOCAL_RUN_PATH: directory,
    DAILY_LOCAL_RUN_ID: runId,
  };
  const child = spawn(
    process.execPath,
    action === "dev"
      ? [fileURLToPath(new URL("./dev.mjs", import.meta.url))]
      : ["--import", observer, "build/server/main.js"],
    { env, windowsHide: true, stdio: ["inherit", "pipe", "pipe"] },
  );
  const streams = [
    createWriteStream(logs.stdout, { flags: "a" }),
    createWriteStream(logs.stderr, { flags: "a" }),
  ];
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    streams[0].write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    streams[1].write(chunk);
  });
  const childIdentity = processIdentity(child.pid);
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    if (
      child.exitCode === null &&
      processIdentity(child.pid) === childIdentity
    ) {
      if (process.platform === "win32")
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else child.kill("SIGTERM");
    }
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (process.channel) {
    process.on("message", (message) => {
      if (message === "shutdown") stop();
    });
    process.once("disconnect", stop);
  }
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
    for (const stream of streams) stream.end();
  });
  child.once("exit", (code) => {
    for (const stream of streams) stream.end();
    process.exitCode = stopping ? 0 : (code ?? 1);
    if (process.connected) process.disconnect();
  });
}
