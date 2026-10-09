import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  if (process.platform === "win32") {
    const text = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){try {$p.StartTime.ToUniversalTime().Ticks.ToString()} catch {exit 2}}; exit 0`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    return text || null;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8")
      .split(") ")
      .at(-1)
      .split(" ")[19];
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export function listenerPids(port) {
  if (process.platform === "win32") {
    const lines = execFileSync("netstat.exe", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      windowsHide: true,
    }).split(/\r?\n/);
    return [
      ...new Set(
        lines.flatMap((line) => {
          const fields = line.trim().split(/\s+/);
          return fields[3] === "LISTENING" && fields[1]?.endsWith(`:${port}`)
            ? [Number(fields[4])]
            : [];
        }),
      ),
    ];
  }
  const lines = execFileSync("ss", ["-H", "-ltnp"], { encoding: "utf8" }).split(
    "\n",
  );
  return [
    ...new Set(
      lines.flatMap((line) =>
        line.split(/\s+/)[3]?.endsWith(`:${port}`)
          ? [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]))
          : [],
      ),
    ),
  ];
}
export function writeJson(path, data) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n");
  renameSync(temporary, path);
}
