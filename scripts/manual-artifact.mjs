import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  lstat,
  rm,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { assertArchiveUploadable } from "./release-guards.mjs";
import {
  isolatedEnvironment,
  localNodeVersion,
  startupPreflight,
} from "./manual-preflight.mjs";

const exec = promisify(execFile);
export const manualChecks = [
  "architecture",
  "types",
  "build",
  "production-startup",
];

export async function fileSha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

export async function assertPureJavaScript(directory) {
  for (const name of await readdir(directory)) {
    const path = resolve(directory, name);
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (!info.isFile() && !info.isDirectory()) ||
      (info.isFile() && info.nlink !== 1)
    )
      throw new Error(
        "UNSAFE_RUNTIME_LINK: only ordinary, unlinked files and directories are allowed",
      );
    if (name.toLowerCase().endsWith(".node"))
      throw new Error(
        "NATIVE_RUNTIME_DEPENDENCY: Windows-to-Linux delivery requires pure JavaScript dependencies",
      );
    if (info.isDirectory()) await assertPureJavaScript(path);
  }
}

/** Builds only the fixed git archive, never the caller's working files. This
 * helper does not connect to a server or run API/browser/migration-note gates. */
export async function buildManualArtifact({
  repository,
  commit,
  baseline,
  runtimeNode,
  node,
  migration,
  output,
  onStep = () => {},
}) {
  if (![commit, baseline].every((value) => /^[a-f0-9]{40}$/.test(value)))
    throw new Error("INVALID_RELEASE_IDENTITY");
  if ((await localNodeVersion(runtimeNode)) !== node)
    throw new Error("NODE_VERSION_MISMATCH");
  const directory = await mkdtemp(resolve(tmpdir(), "manual-build-"));
  const environment = isolatedEnvironment({ runtimeNode, home: directory });
  const run = async (label, cwd, command, args) => {
    const start = Date.now();
    onStep(`${label}...`);
    try {
      await exec(command, args, {
        cwd,
        env: environment,
        windowsHide: true,
        timeout: 600000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      // execFile errors contain command arguments, paths and untrusted output.
      throw new Error(`LOCAL_STEP_FAILED: ${label}`);
    }
    onStep(`${label} completed (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  };
  let outputCreated = false;
  try {
    const { stdout: committedAt } = await exec(
      "git",
      ["show", "-s", "--format=%ct", commit],
      { cwd: repository, env: environment, windowsHide: true },
    );
    if (!/^\d+$/.test(committedAt.trim()))
      throw new Error("INVALID_COMMIT_TIME");
    // Reproducible archives stamp every member and manifest from the source
    // commit; the real wall clock belongs to the release record instead.
    environment.SOURCE_DATE_EPOCH = committedAt.trim();
    const archiveOptions = [
      "--sort=name",
      `--mtime=@${environment.SOURCE_DATE_EPOCH}`,
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--format=gnu",
      "--mode=u+rwX,go+rX,go-w,a-s",
    ];
    const source = resolve(directory, "source"),
      runtime = resolve(directory, "runtime");
    await mkdir(source);
    await run("archive fixed commit", repository, "git", [
      "archive",
      "--format=tar.gz",
      `--output=${resolve(directory, "source.tar.gz")}`,
      commit,
    ]);
    await assertArchiveUploadable({
      archive: resolve(directory, "source.tar.gz"),
    });
    await run("extract source", directory, "tar", [
      "-xzf",
      "source.tar.gz",
      "-C",
      "source",
    ]);
    // npm is taken from the selected official local Node distribution, not npm_execpath.
    const npm = resolve(
      dirname(runtimeNode),
      ...(process.platform === "win32" ? [] : ["..", "lib"]),
      "node_modules/npm/bin/npm-cli.js",
    );
    await run("npm ci (build dependencies)", source, runtimeNode, [
      npm,
      "ci",
      "--no-audit",
      "--no-fund",
    ]);
    await run(
      "npm run build (architecture, types, build)",
      source,
      runtimeNode,
      [npm, "run", "build"],
    );
    await mkdir(runtime);
    for (const name of ["build", "dist", "package.json", "package-lock.json"])
      await cp(resolve(source, name), resolve(runtime, name), {
        recursive: true,
        dereference: false,
      });
    await run("npm ci (production dependencies)", runtime, runtimeNode, [
      npm,
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--bin-links=false",
      "--no-audit",
      "--no-fund",
    ]);
    await mkdir(resolve(runtime, "node_modules"), { recursive: true });
    await assertPureJavaScript(runtime);
    await writeFile(
      resolve(runtime, "release.json"),
      JSON.stringify({ commit }),
    );
    onStep("production-startup (fresh disposable database)...");
    const startupAt = Date.now();
    const { expectedSchema } = await startupPreflight({
      runtime,
      runtimeNode,
      node,
      commit,
    });
    onStep(
      `production-startup completed (${((Date.now() - startupAt) / 1000).toFixed(1)}s); schema=${expectedSchema}`,
    );
    const manifest = {
      schema: 1,
      mode: "manual",
      commit,
      baseline,
      node,
      platform: "linux",
      architecture: "x64",
      expectedSchema,
      checks: [...manualChecks],
      migration,
      builtAt: new Date(
        Number(environment.SOURCE_DATE_EPOCH) * 1000,
      ).toISOString(),
    };
    await writeFile(
      resolve(runtime, "release.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    // tar only receives relative archive/member names, including on Windows.
    await run("pack application", directory, "tar", [
      ...archiveOptions,
      "-czf",
      "application.tar.gz",
      "-C",
      "runtime",
      "build",
      "dist",
      "node_modules",
      "package.json",
      "package-lock.json",
      "release.json",
    ]);
    const archive = resolve(directory, "application.tar.gz");
    await assertArchiveUploadable({ archive });
    const receipt = { ...manifest, sha256: await fileSha256(archive) };
    await mkdir(output); // Refuse replacement, including a previous failed build.
    outputCreated = true;
    await cp(archive, resolve(output, "application.tar.gz"));
    await writeFile(
      resolve(output, "receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n",
      { flag: "wx" },
    );
    await run("pack upload bundle", output, "tar", [
      ...archiveOptions,
      "-czf",
      "bundle.tar.gz",
      "application.tar.gz",
      "receipt.json",
    ]);
    const bundle = resolve(output, "bundle.tar.gz");
    await assertArchiveUploadable({ archive: bundle });
    return { receipt, bundle, bundleSha256: await fileSha256(bundle) };
  } catch (error) {
    if (outputCreated) await rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
