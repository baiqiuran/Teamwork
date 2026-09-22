import { execFile, execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
// Neither TAR_OPTIONS/GIT_DIR nor application secrets may alter these guards.
const toolEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        "path",
        "systemroot",
        "windir",
        "comspec",
        "pathext",
        "temp",
        "tmp",
        "home",
        "userprofile",
      ].includes(key.toLowerCase()),
    ),
  );

async function git(repository, ...args) {
  const { stdout } = await run("git", args, {
    cwd: repository,
    env: toolEnvironment(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
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
    "--untracked-files=normal",
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
  const malformed =
    !/^[0-9a-f]{40}$/.test(running) ||
    (
      await git(repository, "cat-file", "-t", running).catch(() => "")
    ).trim() !== "commit";
  if (malformed)
    throw new Error(
      `PRODUCTION_BASELINE_INVALID: ${running} is not a full commit object in this repository; the release record stores a 40-character commit`,
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

/** Walk every commit (and merge parent), not just the endpoint diff. Disabling
 * rename detection exposes both names, including paths moved OUT of SQLite. */
export async function migrationPaths({ repository, baseline, commit }) {
  if (![baseline, commit].every((value) => /^[0-9a-f]{40}$/.test(value)))
    throw new Error("MIGRATION_RANGE_INVALID");
  const names = await git(
    repository,
    "log",
    "--full-history",
    "-m",
    "--format=",
    "--name-only",
    "--no-renames",
    "-z",
    `${baseline}..${commit}`,
    "--",
  );
  return [
    ...new Set(
      names
        .split("\0")
        .filter((name) => name.startsWith("server/infrastructure/sqlite/")),
    ),
  ].sort();
}

export async function migrationSummary({ repository, baseline, commit }) {
  if (![baseline, commit].every((value) => /^[0-9a-f]{40}$/.test(value)))
    throw new Error("MIGRATION_RANGE_INVALID");
  return git(
    repository,
    "log",
    "--full-history",
    "-m",
    "--format=commit %H%n%s",
    "--stat",
    "--patch",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--no-color",
    `${baseline}..${commit}`,
    "--",
    "server/infrastructure/sqlite/",
  );
}

/** Public confirmation policy; the CLI obtains the response from a TTY only. */
export function confirmMigration({
  baseline,
  commit,
  paths,
  interactive,
  response,
}) {
  if (!paths.length) return { paths: [], confirmed: false };
  if (!interactive || response !== `MIGRATE ${baseline} ${commit}`)
    throw new Error(
      "MIGRATION_CONFIRMATION_REQUIRED: cancelled; no build or upload performed",
    );
  return { paths, confirmed: true };
}

function listed(archive, ...flags) {
  // GNU tar reads "C:\path" as "host:path", so it only ever sees a name.
  return execFileSync("tar", [...flags, basename(archive)], {
    cwd: dirname(archive),
    env: toolEnvironment(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
    .split("\n")
    .filter(Boolean);
}

/**
 * Refuse an artifact the server would not unpack. `ops/snapshots.mjs` applies
 * the same two rules again before extraction, so catching them here is what
 * keeps a laptop build from being rejected only after it has been uploaded.
 */
export async function assertArchiveUploadable({ archive }) {
  const escaping = listed(archive, "-tzf").filter(
    (path) =>
      path.startsWith("/") ||
      /^[a-zA-Z]:/.test(path) ||
      path.includes("\\") ||
      path.split("/").includes(".."),
  );
  if (escaping.length)
    throw new Error(
      `UNSAFE_ARCHIVE_PATH: ${escaping.join(", ")} would be written outside the release directory`,
    );
  const special = listed(archive, "--numeric-owner", "-tvzf").filter(
    (line) => !["-", "d"].includes(line[0]),
  );
  if (special.length)
    throw new Error(
      `UNSAFE_ARCHIVE_LINK: only plain files and directories may be uploaded, found ${special.join("; ")}`,
    );
}
