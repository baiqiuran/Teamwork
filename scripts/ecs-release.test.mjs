import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  cp,
  copyFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

async function packageFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "daily-ecs-package-"));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  const repository = join(root, "repository"),
    temporary = join(root, "tmp"),
    tools = join(root, "tools");
  for (const directory of [repository, temporary, tools])
    await mkdir(directory);
  for (const directory of ["server", "src", "scripts", "tests"])
    await mkdir(join(repository, directory));
  await cp("deploy-ecs.bat", join(repository, "deploy-ecs.bat"));
  for (const file of ["deploy-ecs.sh", "ecs-release.mjs"]) {
    try {
      await cp(`scripts/${file}`, join(repository, "scripts", file));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await writeFile(join(repository, "src", "marker.txt"), "committed source");
  await writeFile(join(repository, "server", "marker.txt"), "server source");
  await writeFile(join(repository, "tests", "marker.txt"), "test fixture");
  for (const file of ["tsconfig.json", "tsconfig.server.json"])
    await writeFile(join(repository, file), "{}");
  await writeFile(
    join(repository, "playwright.config.ts"),
    "export default {};",
  );
  await writeFile(join(repository, "index.html"), "<html>fixture</html>");
  const pkg = {
    name: "ecs-fixture",
    version: "1.0.0",
    type: "module",
    scripts: { build: "node scripts/build.mjs" },
  };
  await writeFile(join(repository, "package.json"), JSON.stringify(pkg));
  await writeFile(
    join(repository, "package-lock.json"),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      packages: { "": pkg },
    }),
  );
  await writeFile(
    join(repository, "scripts", "build.mjs"),
    `import {mkdirSync,writeFileSync,readFileSync} from "node:fs"; mkdirSync("build/server",{recursive:true});mkdirSync("dist",{recursive:true});writeFileSync("build/server/main.js","console.log('fixture');");writeFileSync("dist/index.html",readFileSync("src/marker.txt"));`,
  );
  // If package-only ever contacts SSH, these inert binaries fail before networking.
  for (const file of ["ssh.exe", "scp.exe"]) {
    await copyFile(
      join(process.env.SystemRoot, "System32", "where.exe"),
      join(tools, file),
    );
  }
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  const hooks = join(root, "empty-hooks");
  await mkdir(hooks);
  git("config", "core.hooksPath", hooks);
  git("add", ".");
  git("commit", "-m", "fixture");
  return {
    repository,
    git,
    run: () =>
      execFileSync("cmd.exe", ["/d", "/c", "deploy-ecs.bat --package-only"], {
        cwd: repository,
        encoding: "utf8",
        windowsHide: true,
        timeout: 120000,
        env: {
          ...process.env,
          TEMP: temporary,
          TMP: temporary,
          PATH: `${tools};${process.env.PATH}`,
        },
      }),
  };
}

test(
  "ECS package-only carries a committed version and matching external archive receipt without SSH",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await packageFixture(t);
    const commit = f.git("rev-parse", "HEAD");
    const output = f.run();
    const archive = output.match(/^Package:\s*(.+)$/m)?.[1].trim();
    assert.ok(archive, output);
    const files = execFileSync("tar.exe", ["-tf", archive], {
      encoding: "utf8",
    });
    assert.ok(
      files.split(/\r?\n/).includes("release.json"),
      "runtime archive must contain source identity",
    );
    const metadata = JSON.parse(
      execFileSync("tar.exe", ["-xOf", archive, "release.json"], {
        encoding: "utf8",
      }),
    );
    const receipt = JSON.parse(
      await readFile(join(dirname(archive), "receipt.json"), "utf8"),
    );
    assert.equal(metadata.commit, commit);
    assert.equal(metadata.sourceDirty, false);
    assert.equal(receipt.version, commit);
    assert.equal(
      receipt.sha256,
      createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
    );
    assert.equal(f.git("rev-parse", "HEAD"), commit);
  },
);

test(
  "ECS package-only identifies and includes local source changes without changing Git",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await packageFixture(t);
    const commit = f.git("rev-parse", "HEAD");
    await writeFile(
      join(f.repository, "src", "marker.txt"),
      "working tree change",
    );
    const output = f.run();
    const archive = output.match(/^Package:\s*(.+)$/m)?.[1].trim();
    assert.ok(archive, output);
    const receipt = JSON.parse(
      await readFile(join(dirname(archive), "receipt.json"), "utf8"),
    );
    assert.equal(receipt.commit, commit);
    assert.equal(receipt.sourceDirty, true);
    assert.match(
      receipt.version,
      new RegExp(`^${commit}-dirty\\.[a-f0-9]{12}$`),
    );
    assert.equal(
      execFileSync("tar.exe", ["-xOf", archive, "dist/index.html"], {
        encoding: "utf8",
      }),
      "working tree change",
    );
    assert.equal(f.git("show", "HEAD:src/marker.txt"), "committed source");
    assert.equal(
      receipt.sha256,
      createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
    );
    assert.equal(f.git("rev-parse", "HEAD"), commit);
  },
);
