import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";

const run = promisify(execFile);

/** Members an upload may carry: payload plus the metadata records tar writes. */
const UPLOADABLE = new Set(["0", "\0", "7", "5", "x", "g", "L", "K"]);
const SPECIAL = {
  1: "hardlink",
  2: "symlink",
  3: "character device",
  4: "block device",
  6: "fifo",
};

async function git(repository, ...args) {
  const { stdout } = await run("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
}

/** Exit status only: used for questions the repository answers with a code. */
async function gitSucceeds(repository, ...args) {
  try {
    await git(repository, ...args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse to build a release the repository cannot reproduce.
 * Resolves with the commit to publish.
 */
export async function preflightRelease({ repository, baseline }) {
  const status = await git(
    repository,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  );
  if (status.trim()) {
    const paths = status
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.slice(3).split(" -> ").pop());
    throw new Error(
      `DIRTY_WORKTREE: ${paths.length} change(s) not in the release commit, they would be absent from the build: ${paths.join(", ")}`,
    );
  }
  const head = (await git(repository, "rev-parse", "HEAD")).trim();
  const remoteMain = (
    await git(
      repository,
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/remotes/origin/main",
    ).catch(() => "")
  ).trim();
  const pushed =
    remoteMain &&
    (await gitSucceeds(
      repository,
      "merge-base",
      "--is-ancestor",
      head,
      remoteMain,
    ));
  if (!pushed)
    throw new Error(
      `HEAD_NOT_PUSHED: ${head} is not contained in origin/main (${remoteMain || "no such ref fetched locally"}); fetch or push it before building`,
    );
  const running = String(baseline ?? "").trim();
  if (!running)
    throw new Error(
      "PRODUCTION_BASELINE_UNKNOWN: the version production is running has to come from the release record, or from the read-only survey for the first release; a commit quoted from documentation is not evidence",
    );
  if (
    !(await gitSucceeds(
      repository,
      "merge-base",
      "--is-ancestor",
      running,
      head,
    ))
  )
    throw new Error(
      `PRODUCTION_BASELINE_UNRELATED: ${running} is not a version the release commit ${head} descends from`,
    );
  return { commit: head, baseline: running };
}

function field(header, offset, length) {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return (end < 0 ? bytes : bytes.subarray(0, end)).toString("utf8").trim();
}

/** Refuse an artifact the server would unpack into something other than files. */
export async function assertArchiveUploadable({ archive }) {
  const unsafe = [];
  let pending = Buffer.alloc(0);
  let skip = 0;
  const consume = (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (skip) {
        const used = Math.min(skip, pending.length);
        pending = pending.subarray(used);
        skip -= used;
        if (skip) return;
      }
      if (pending.length < 512) return;
      const header = pending.subarray(0, 512);
      pending = pending.subarray(512);
      if (!header.some((byte) => byte)) return;
      const rawSize = header.subarray(124, 136);
      const digits = field(header, 124, 12);
      if (rawSize[0] & 0x80 || !/^[0-7]*$/.test(digits))
        throw new Error(`ARTIFACT_UNREADABLE: ${archive} is not a tar stream`);
      const name = [field(header, 345, 155), field(header, 0, 100)]
        .filter(Boolean)
        .join("/");
      const typeflag = String.fromCharCode(header[156] || 0x30);
      if (!UPLOADABLE.has(typeflag))
        unsafe.push(`${name} (${SPECIAL[typeflag] ?? `type ${typeflag}`})`);
      skip = Math.ceil(parseInt(digits || "0", 8) / 512) * 512;
    }
  };
  await pipeline(createReadStream(archive), createGunzip(), async (source) => {
    for await (const chunk of source) consume(chunk);
  });
  if (unsafe.length)
    throw new Error(
      `ARTIFACT_HAS_UNSAFE_ENTRIES: ${unsafe.join(", ")} — only plain files and directories may be uploaded`,
    );
}
