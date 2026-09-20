import { writeFile, readFile, mkdir, chmod } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { run, port } from "./fixture.mjs";
export async function sshFixture(t, f) {
  const sshPort = await port(),
    user = "deploy" + f.id.slice(-8);
  run(
    "useradd",
    "--no-create-home",
    "--shell",
    "/bin/sh",
    "--password",
    "invalid-unusable-hash",
    user,
  );
  run("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", f.root + "/ssh-key");
  run(
    "ssh-keygen",
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    f.root + "/ssh-host",
  );
  const entry = `/usr/local/sbin/${f.id}-gateway`;
  await writeFile(
    entry,
    `#!/bin/sh\nset -eu\n[ "$#" -eq 1 ] || exit 64\nexec /usr/local/bin/node /repository/ops/gateway.mjs --config ${f.root}/deploy.json --command "$1"\n`,
  );
  await chmod(entry, 0o755);
  await writeFile(
    `/etc/sudoers.d/${f.id}`,
    `${user} ALL=(root) NOPASSWD: ${entry}\n`,
    { mode: 0o440 },
  );
  await writeFile(
    f.root + "/authorized",
    `command="sudo -n ${entry} \\"$SSH_ORIGINAL_COMMAND\\"",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ${(await readFile(f.root + "/ssh-key.pub", "utf8")).trim()}\n`.replaceAll(
      '\\\\"',
      '\\"',
    ),
  );
  await writeFile(
    f.root + "/known_hosts",
    `[127.0.0.1]:${sshPort} ${(await readFile(f.root + "/ssh-host.pub", "utf8")).trim()}\n`,
  );
  await mkdir("/run/sshd", { recursive: true });
  const sshd = spawn(
    "/usr/sbin/sshd",
    [
      "-D",
      "-e",
      "-p",
      String(sshPort),
      "-h",
      f.root + "/ssh-host",
      "-o",
      "ListenAddress=127.0.0.1",
      "-o",
      `AuthorizedKeysFile=${f.root}/authorized`,
      "-o",
      "StrictModes=no",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "UsePAM=no",
      "-o",
      `AllowUsers=${user}`,
    ],
    { stdio: "ignore" },
  );
  t.after(() => sshd.kill());
  await new Promise((r) => setTimeout(r, 200));
  const args = [
    "-p",
    String(sshPort),
    "-i",
    f.root + "/ssh-key",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${f.root}/known_hosts`,
    "-o",
    "ConnectTimeout=5",
    `${user}@127.0.0.1`,
  ];
  return async (command, file) => {
    const child = spawn("ssh", [...args, command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      error = "";
    child.stdout.on("data", (v) => (output += v));
    child.stderr.on("data", (v) => (error += v));
    if (file) createReadStream(file).pipe(child.stdin);
    else child.stdin.end();
    child.stdin.on("error", () => {});
    const [code] = await once(child, "exit");
    return { code, output, error };
  };
}
