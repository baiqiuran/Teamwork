import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, relative } from "node:path";

const [action, destination] = process.argv.slice(2);
if (!destination || !["capture", "seal", "verify", "record"].includes(action))
  throw new Error(
    "Usage: ecs-release.mjs capture|seal|verify|record <directory>",
  );
const directory = resolve(destination);
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const write = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
const tar = process.platform === "win32" ? "tar.exe" : "tar";

function identity(value) {
  if (
    value.schema !== 1 ||
    value.mode !== "ecs-simple" ||
    !/^[a-f0-9]{40}$/.test(value.commit) ||
    typeof value.sourceDirty !== "boolean" ||
    !/^[a-f0-9]{64}$/.test(value.sourceDigest)
  )
    throw new Error("Invalid ECS source identity");
  const version = value.sourceDirty
    ? `${value.commit}-dirty.${value.sourceDigest.slice(0, 12)}`
    : value.commit;
  if (value.version !== version)
    throw new Error("ECS version does not match source identity");
  return value;
}

function sourceDigest(root) {
  const hash = createHash("sha256");
  function visit(path) {
    const file = lstatSync(path);
    if (file.isDirectory())
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
    else if (file.isFile()) {
      hash.update(relative(root, path).replaceAll("\\", "/") + "\0");
      hash.update(String(file.size) + "\0");
      hash.update(readFileSync(path));
    } else
      throw new Error("Source identity cannot cover links or special files");
  }
  visit(root);
  return hash.digest("hex");
}

if (action === "capture") {
  const repository = process.cwd();
  const git = (...args) => run("git", args, repository).trim();
  const commit = git("rev-parse", "HEAD");
  const inputs = [
    "server",
    "src",
    "scripts",
    "tests",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.server.json",
    "playwright.config.ts",
    "index.html",
    ...["vite.config.ts", "public"].filter((path) =>
      existsSync(resolve(repository, path)),
    ),
  ];
  const sourceDirty = Boolean(
    git("status", "--porcelain", "--untracked-files=all", "--", ...inputs) ||
    git(
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--",
      ...inputs,
    ),
  );
  mkdirSync(directory);
  mkdirSync(join(directory, "source"));
  if (sourceDirty)
    run(tar, ["-cf", "source.tar", "-C", repository, ...inputs], directory);
  else {
    const tracked = inputs.filter((path) => git("ls-tree", commit, "--", path));
    run(
      "git",
      [
        "archive",
        "--format=tar",
        "--output",
        join(directory, "source.tar"),
        commit,
        "--",
        ...tracked,
      ],
      repository,
    );
  }
  run(tar, ["-xf", "source.tar", "-C", "source"], directory);
  const digest = sourceDigest(join(directory, "source"));
  const metadata = {
    schema: 1,
    mode: "ecs-simple",
    commit,
    sourceDirty,
    sourceDigest: digest,
    version: sourceDirty ? `${commit}-dirty.${digest.slice(0, 12)}` : commit,
    capturedAt: new Date().toISOString(),
  };
  write(join(directory, "source.json"), metadata);
  write(join(directory, "source", "release.json"), metadata);
  console.log(`Source version: ${metadata.version}`);
} else if (action === "seal") {
  const metadata = identity(json(join(directory, "source.json")));
  write(join(directory, "source", "release.json"), metadata);
  run(
    tar,
    [
      "-czf",
      "../application.tar.gz",
      "build",
      "dist",
      "package.json",
      "package-lock.json",
      "release.json",
    ],
    join(directory, "source"),
  );
  write(join(directory, "receipt.json"), {
    ...metadata,
    sha256: sha256(join(directory, "application.tar.gz")),
    packagedAt: new Date().toISOString(),
  });
} else if (action === "verify") {
  const receipt = identity(json(join(directory, "receipt.json")));
  if (receipt.sha256 !== sha256(join(directory, "application.tar.gz")))
    throw new Error("ECS archive checksum mismatch");
  const metadata = identity(json(join(directory, "release.json")));
  for (const field of ["commit", "sourceDirty", "sourceDigest", "version"])
    if (metadata[field] !== receipt[field])
      throw new Error("ECS archive identity mismatch");
  console.log(receipt.version);
} else {
  const [status, release, snapshot, startedAt, healthPath] =
    process.argv.slice(4);
  if (!["prepared", "failed", "completed", "unconfirmed"].includes(status))
    throw new Error("Invalid ECS release status");
  let receipt;
  try {
    receipt = identity(json(join(directory, "receipt.json")));
  } catch (error) {
    if (status !== "failed") throw error;
  }
  const actualSha = existsSync(join(directory, "application.tar.gz"))
    ? sha256(join(directory, "application.tar.gz"))
    : null;
  let health = null;
  try {
    if (healthPath && existsSync(healthPath)) health = json(healthPath);
  } catch (error) {
    if (status !== "failed") throw error;
  }
  if (
    status === "completed" &&
    (actualSha !== receipt?.sha256 ||
      health?.ready !== true ||
      health.version !== receipt.version)
  )
    throw new Error("Running ECS version mismatch");
  write(join(directory, "release-record.json"), {
    schema: 1,
    version: receipt?.version ?? null,
    commit: receipt?.commit ?? null,
    sourceDirty: receipt?.sourceDirty ?? null,
    sourceDigest: receipt?.sourceDigest ?? null,
    artifactSha256: actualSha,
    expectedArtifactSha256: receipt?.sha256 ?? null,
    release: release && release !== "-" ? release : null,
    snapshot: snapshot && snapshot !== "-" ? snapshot : null,
    startedAt,
    finishedAt: status === "prepared" ? null : new Date().toISOString(),
    health: health ? { ready: health.ready, version: health.version } : null,
    status,
  });
}
