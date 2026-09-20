import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { sshControl } from "./ssh-control.mjs";

const env = process.env,
  remote = sshControl(env);
const origin = new URL(env.DEPLOY_URL);
assert.equal(origin.protocol, "https:");
assert.equal(origin.origin, env.DEPLOY_URL);
const id = `gh-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
assert.match(id, /^gh-[0-9]+-[0-9]+$/);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function report(value) {
  const text = JSON.stringify(value);
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY)
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `\n\n巡检结果：\n\n\`\`\`json\n${text}\n\`\`\`\n`,
    );
}
async function inspect(identifier) {
  try {
    return await remote(`inspect ${identifier}`);
  } catch (error) {
    if (error.result) return error.result;
    throw error;
  }
}
async function publicCheck(commit) {
  const read = (path, method = "GET") =>
    fetch(new URL(path, origin), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  const ready = await read("/health/ready");
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ready: true, version: commit });
  for (const [path, status, method] of [
    ["/login", 200],
    ["/mcp", 401, "POST"],
    ["/oauth/authorize", 400],
    ["/.well-known/oauth-authorization-server", 200],
  ]) {
    assert.equal((await read(path, method)).status, status);
  }
}
let confirmed = false,
  failedSamples = 0;
for (let attempt = 0; attempt < 21; attempt++) {
  const result = await inspect(`${id}-${attempt}`);
  await report(result);
  if (result.phase === "busy") {
    await wait(30000);
    continue;
  }
  // Backup/drill alarms must not suppress the independent public check.
  if (!/^[a-f0-9]{40}$/.test(result.actualCommit ?? "")) break;
  let publicHealthy = false;
  try {
    await publicCheck(result.actualCommit);
    publicHealthy = true;
    await report({ publicHttps: "healthy", actualCommit: result.actualCommit });
  } catch {
    try {
      await report(await remote(`external-failure ${result.id}`));
    } catch (error) {
      if (error.result) await report(error.result);
      else throw error;
    }
  }
  if (result.phase === "healthy" && publicHealthy) {
    const completed = await remote(`inspection-complete ${result.id}`);
    await report(completed);
    if (completed.phase === "completed") {
      confirmed = true;
      break;
    }
    if (completed.phase === "busy") {
      await wait(30000);
      continue;
    }
    break;
  }
  if (publicHealthy && result.publicService?.healthy) break;
  if (++failedSamples >= 3) break;
  await wait(31000);
}
assert.ok(
  confirmed,
  "INSPECTION_FAILED: follow reported issue codes; preserve current data, do not replay deployment",
);
