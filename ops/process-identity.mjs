import { readFile } from "node:fs/promises";
export const bootId = async () =>
  (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
export async function processIdentity(pid = process.pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  return {
    pid,
    bootId: await bootId(),
    startTime: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
  };
}
export async function alive(identity) {
  try {
    const current = await processIdentity(identity.pid);
    return (
      current.bootId === identity.bootId &&
      current.startTime === identity.startTime
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
