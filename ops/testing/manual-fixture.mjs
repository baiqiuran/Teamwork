import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fixture, run } from "./fixture.mjs";
import { json, sha256 } from "../io.mjs";

export async function manualFixture(t) {
  const f = await fixture();
  t.after(async () => {
    run("systemctl", "stop", f.config.unit);
    await rm(`/etc/nginx/conf.d/${f.id}.conf`, { force: true });
    run("systemctl", "reload", "nginx");
    await rm(`/etc/systemd/system/${f.id}.service`, { force: true });
    run("systemctl", "daemon-reload");
    await rm(f.root, { recursive: true, force: true });
  });
  const token = randomUUID() + randomUUID();
  f.config.healthTokenFile = `${f.root}/health-token`;
  f.config.incoming = `${f.root}/incoming`;
  f.config.manualAccessLog = `${f.root}/access.log`;
  const proxyConfig = `/etc/nginx/conf.d/${f.id}.conf`;
  const format = `manual_${f.id.replaceAll("-", "_")}`;
  await writeFile(
    proxyConfig,
    `log_format ${format} escape=json '{"status":$status,"upstream":"$upstream_status","retryAfter":"$sent_http_retry_after"}';\n${(await readFile(proxyConfig, "utf8")).replace("server {", `server { access_log ${f.config.manualAccessLog} ${format}; location = /fixture-error { return 502; }`)}`,
  );
  run("nginx", "-t");
  run("systemctl", "reload", "nginx");
  await mkdir(f.config.incoming);
  await writeFile(f.config.healthTokenFile, token, { mode: 0o600 });
  await appendFile(f.config.envFile, `DAILY_HEALTH_TOKEN=${token}\n`);
  await writeFile(`${f.root}/deploy.json`, JSON.stringify(f.config));
  f.baseline = (await json(`${f.root}/current/release.json`)).commit;
  await writeFile(
    `${f.root}/control/runtime.json`,
    JSON.stringify({ commit: f.baseline, artifact: f.config.artifact }),
  );
  run("systemctl", "restart", f.config.unit);
  let health;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(
        new URL("/internal/health", f.config.probeUrl),
        { headers: { "X-Daily-Health": token } },
      );
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(health, "fixture must start with real deep health");
  f.expectedSchema = health.schema;
  f.candidate = async (id, change = async () => {}) => {
    const path = `${f.config.incoming}/${id}`;
    await mkdir(path);
    const runtime = `${f.root}/candidate-${id}`;
    run("cp", "-a", "/fixture-runtime", runtime);
    const manifest = {
      schema: 1,
      mode: "manual",
      commit: "b".repeat(40),
      baseline: f.baseline,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      expectedSchema: f.expectedSchema,
      checks: ["architecture", "types", "build", "production-startup"],
      migration: { paths: [], confirmed: false },
      builtAt: new Date().toISOString(),
    };
    await writeFile(`${runtime}/release.json`, JSON.stringify(manifest));
    await change(runtime, manifest);
    run(
      "tar",
      "-czf",
      `${path}/application.tar.gz`,
      "-C",
      runtime,
      "build",
      "dist",
      "node_modules",
      "package.json",
      "package-lock.json",
      "release.json",
    );
    await writeFile(
      `${path}/receipt.json`,
      JSON.stringify({
        ...manifest,
        sha256: await sha256(`${path}/application.tar.gz`),
      }),
    );
    await rm(runtime, { recursive: true, force: true });
    return path;
  };
  return f;
}
