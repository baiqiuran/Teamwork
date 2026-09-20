import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";

export function sshControl(env) {
  assert.match(env.DEPLOY_HOST ?? "", /^[a-zA-Z0-9.-]+$/);
  assert.match(env.DEPLOY_USER ?? "", /^[a-z_][a-z0-9_-]*$/);
  for (const name of ["DEPLOY_KEY_FILE", "DEPLOY_KNOWN_HOSTS"])
    assert.ok(env[name]);
  const args = [
    "-i",
    env.DEPLOY_KEY_FILE,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${env.DEPLOY_KNOWN_HOSTS}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    `${env.DEPLOY_USER}@${env.DEPLOY_HOST}`,
  ];
  return async (command, file) => {
    const child = spawn("ssh", [...args, command], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.on("data", (v) => (output += v));
    child.stdin.on("error", () => {});
    if (file) createReadStream(file).pipe(child.stdin);
    else child.stdin.end();
    const [code] = await once(child, "close");
    if (!output.trim())
      throw new Error(
        "SSH_OBSERVATION_FAILED: query the same operation on rerun",
      );
    const result = JSON.parse(output);
    if (code !== 0) {
      const error = new Error(result.error ?? "REMOTE_OPERATION_FAILED");
      error.result = result;
      throw error;
    }
    return result;
  };
}
