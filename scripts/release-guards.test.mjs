import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import {
  preflightRelease,
  assertArchiveUploadable,
} from "./release-guards.mjs";

/** Committed fixture repository; returns its root, git runner and only commit. */
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "daily-release-guards-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "release-guard@fixture.test");
  git("config", "user.name", "Release guard fixture");
  await writeFile(resolve(root, "package.json"), JSON.stringify({ name: "f" }));
  git("add", ".");
  git("commit", "-m", "fixture");
  return { root, git, commit: git("rev-parse", "HEAD") };
}

test("a worktree with uncommitted work is refused before the build starts", async (t) => {
  const { root, commit } = await fixture(t);
  // The committed version is the one that would be published, so both a
  // modified file and an untracked file are work the release cannot reproduce.
  await writeFile(resolve(root, "package.json"), JSON.stringify({ name: "x" }));
  await writeFile(resolve(root, "hotfix-notes.md"), "not committed yet");
  await assert.rejects(
    () => preflightRelease({ repository: root, baseline: commit }),
    (error) => {
      assert.match(error.message, /^DIRTY_WORKTREE/);
      assert.match(error.message, /hotfix-notes\.md/);
      assert.match(error.message, /package\.json/);
      assert.match(
        error.message,
        /not in the release commit/,
        "the refusal has to say what is missing",
      );
      return true;
    },
  );
});

test("a commit the remote main branch does not contain is refused", async (t) => {
  const { root, git, commit } = await fixture(t);
  await writeFile(resolve(root, "server.ts"), "// only on this laptop");
  git("add", ".");
  git("commit", "-m", "unpushed work");
  git("update-ref", "refs/remotes/origin/main", commit);
  await assert.rejects(
    () => preflightRelease({ repository: root, baseline: commit }),
    (error) => {
      assert.match(error.message, /^HEAD_NOT_PUSHED/);
      assert.match(error.message, /origin\/main/);
      return true;
    },
  );
});

test("a release without evidence of the running version is refused", async (t) => {
  const { root, git, commit } = await fixture(t);
  git("update-ref", "refs/remotes/origin/main", commit);
  await assert.rejects(
    () => preflightRelease({ repository: root, baseline: "" }),
    (error) => {
      assert.match(error.message, /^PRODUCTION_BASELINE_UNKNOWN/);
      assert.match(
        error.message,
        /release record/,
        "the refusal has to name the evidence it needs, not a document",
      );
      return true;
    },
  );
});

test("a baseline that is not a commit object is refused as malformed", async (t) => {
  const { root, git, commit } = await fixture(t);
  git("update-ref", "refs/remotes/origin/main", commit);
  for (const value of ["not-a-sha", "f".repeat(40), `${commit}~1`]) {
    await assert.rejects(
      () => preflightRelease({ repository: root, baseline: value }),
      (error) => {
        assert.match(error.message, /^PRODUCTION_BASELINE_INVALID/);
        assert.ok(error.message.includes(value), `must name ${value}`);
        return true;
      },
      `${value} has to be refused as a malformed value, not as an unrelated commit`,
    );
  }
});

test("a baseline the release commit does not descend from is refused", async (t) => {
  const { root, git } = await fixture(t);
  await writeFile(resolve(root, "server.ts"), "// pushed work");
  git("add", ".");
  git("commit", "-m", "pushed");
  const head = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", head);
  // A commit ahead of, or beside, the release cannot be what production runs.
  git("checkout", "-b", "side", head);
  await writeFile(resolve(root, "later.ts"), "// never deployed");
  git("add", ".");
  git("commit", "-m", "side work");
  const ahead = git("rev-parse", "HEAD");
  git("checkout", "main");
  assert.equal(git("status", "--porcelain"), "");
  await assert.rejects(
    () => preflightRelease({ repository: root, baseline: ahead }),
    (error) => {
      assert.match(error.message, /^PRODUCTION_BASELINE_UNRELATED/);
      assert.ok(
        error.message.includes(ahead),
        "the refusal has to name the value it rejected",
      );
      return true;
    },
  );
});

test("a pushed commit on a clean worktree with a recorded baseline is accepted", async (t) => {
  const { root, git, commit } = await fixture(t);
  await writeFile(resolve(root, "server.ts"), "// pushed work");
  git("add", ".");
  git("commit", "-m", "pushed");
  const head = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", head);
  const released = await preflightRelease({
    repository: root,
    baseline: `  ${commit}  `,
  });
  assert.equal(released.commit, head);
  assert.equal(
    released.baseline,
    commit,
    "the accepted baseline is what later steps record and diff against",
  );
});

/** One ustar member, laid out per POSIX so the fixture is not the parser's mirror. */
function member({ name, typeflag = "0", body = "", linkname = "" }) {
  const data = Buffer.from(body);
  const header = Buffer.alloc(512);
  const octal = (value, digits) =>
    value.toString(8).padStart(digits - 1, "0") + "\0";
  header.write(name, 0, 100);
  header.write(octal(0o644, 8), 100);
  header.write(octal(0, 8), 108);
  header.write(octal(0, 8), 116);
  header.write(octal(data.length, 12), 124);
  header.write(octal(0, 12), 136);
  header.write("        ", 148);
  header.write(typeflag, 156);
  header.write(linkname, 157, 100);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(octal(sum, 8), 148);
  return Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ]);
}

async function syntheticArtifact(t, entries) {
  const root = await mkdtemp(resolve(tmpdir(), "daily-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = resolve(root, "application.tar.gz");
  await writeFile(
    archive,
    gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])),
  );
  return archive;
}

const SPECIAL_ENTRIES = [
  ["2", "node_modules/some-package/current", "target.txt", "symbolic link"],
  ["1", "node_modules/some-package/hard.txt", "target.txt", "hard link"],
  ["3", "dev/null", "", "character device"],
  ["4", "dev/sda", "", "block device"],
  ["6", "run/service.fifo", "", "fifo"],
];

test("an artifact holding links or devices is refused before upload", async (t) => {
  for (const [typeflag, name, linkname, kind] of SPECIAL_ENTRIES) {
    const archive = await syntheticArtifact(t, [
      member({ name: "package.json", body: '{"name":"release"}' }),
      member({ name, typeflag, linkname }),
    ]);
    await assert.rejects(
      () => assertArchiveUploadable({ archive }),
      (error) => {
        assert.match(error.message, /^UNSAFE_ARCHIVE_LINK/);
        assert.ok(error.message.includes(name), `must name ${name}`);
        return true;
      },
      `${kind} must not be uploadable`,
    );
  }
});

test("an artifact member that would land outside its directory is refused", async (t) => {
  for (const name of ["/etc/passwd", "../../etc/shadow"]) {
    const archive = await syntheticArtifact(t, [
      member({ name: "package.json", body: '{"name":"release"}' }),
      member({ name, body: "x" }),
    ]);
    await assert.rejects(
      () => assertArchiveUploadable({ archive }),
      (error) => {
        assert.match(error.message, /^UNSAFE_ARCHIVE_PATH/);
        assert.ok(error.message.includes(name), `must name ${name}`);
        return true;
      },
      `${name} must not be uploadable`,
    );
  }
});

test("an artifact tar produced from plain files is accepted", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "daily-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Over 100 characters makes tar write a long-name record; that is metadata, not payload.
  const nested = resolve(
    root,
    "runtime/node_modules/@daily/some-dependency/dist/packages/server/src/lib/deep/nested",
  );
  await mkdir(nested, { recursive: true });
  await writeFile(resolve(root, "runtime/package.json"), '{"name":"release"}');
  await writeFile(resolve(nested, "index.js"), "export const ok = true;");
  // Relative paths: GNU tar reads "C:/..." as a remote host.
  execFileSync("tar", ["-czf", "application.tar.gz", "runtime"], {
    cwd: root,
    windowsHide: true,
  });
  await assertArchiveUploadable({
    archive: resolve(root, "application.tar.gz"),
  });
});
