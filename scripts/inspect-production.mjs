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
let result;
// A maintenance window is observed, never cancelled by a scheduled check.
for (let n = 0; n < 21; n++) {
  result = await inspect(`${id}-wait-${n}`);
  if (result.phase !== "busy") break;
  await wait(30000);
}
if (
  result.publicService?.healthy === false &&
  !result.publicService.maintenance
) {
  for (let n = 0; n < 2; n++) {
    await wait(31000);
    result = await inspect(`${id}-retry-${n}`);
    if (result.publicService?.healthy) break;
  }
}
await report(result);
if (result.phase !== "healthy")
  throw new Error(
    "INSPECTION_FAILED: follow the reported issue codes; do not replay a deployment or restore old data",
  );
try {
  await publicCheck(result.actualCommit);
} catch {
  await report({
    phase: "failed",
    issues: ["EXTERNAL_HTTPS_OR_PROTOCOL_FAILED"],
    actualCommit: result.actualCommit,
  });
  throw new Error(
    "EXTERNAL_CHECK_FAILED: inspect ingress/network/certificate; host data was not restored",
  );
}
await report(await remote(`inspection-complete ${result.id}`));
