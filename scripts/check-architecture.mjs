import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsers } from "prettier/plugins/typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const normalize = (path) => relative(root, path).replaceAll("\\", "/");
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? files(path)
      : /\.tsx?$/.test(entry.name)
        ? [path]
        : [];
  });
}
const graph = new Map(),
  errors = [];
function resolveImport(from, specifier) {
  if (!specifier.startsWith(".")) return specifier;
  const base = resolve(dirname(from), specifier);
  return normalize(
    [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      resolve(base, "index.ts"),
      resolve(base, "index.tsx"),
    ].find((path) => existsSync(path)) ?? base,
  );
}
function violation(from, target, rule) {
  errors.push(`${from} -> ${target}: ${rule}`);
}
function check(from, target) {
  if (
    (from.startsWith("server/") && target.startsWith("src/")) ||
    (from.startsWith("src/") && target.startsWith("server/"))
  )
    violation(
      from,
      target,
      "Client and server communicate through HTTP contracts",
    );
  if (
    from.startsWith("server/domain/") &&
    !target.startsWith("server/domain/") &&
    target !== "zod"
  )
    violation(
      from,
      target,
      "Domain may only depend on domain and pure validation",
    );
  if (
    from.startsWith("server/application/") &&
    !target.startsWith("server/domain/") &&
    !target.startsWith("server/application/")
  )
    violation(from, target, "Application depends on domain and its own ports");
  if (
    from.startsWith("server/infrastructure/") &&
    target.startsWith("server/") &&
    !target.startsWith("server/domain/") &&
    !target.startsWith("server/infrastructure/") &&
    target !== "server/application/ports.ts"
  )
    violation(
      from,
      target,
      "Infrastructure implements ports, never calls use cases or HTTP",
    );
  if (
    from.startsWith("server/interfaces/") &&
    target.startsWith("server/") &&
    !["server/domain/", "server/application/", "server/interfaces/"].some(
      (prefix) => target.startsWith(prefix),
    )
  )
    violation(from, target, "HTTP must not choose infrastructure adapters");
  if (
    target === "node:sqlite" &&
    !from.startsWith("server/infrastructure/sqlite/")
  )
    violation(from, target, "SQLite is private to infrastructure");
  if (
    (["express", "helmet", "express-rate-limit"].includes(target) ||
      target.startsWith("@nestjs/")) &&
    !from.startsWith("server/interfaces/http/") &&
    !from.startsWith("server/composition/") &&
    from !== "server/app.ts" &&
    from !== "server/main.ts"
  )
    violation(
      from,
      target,
      "HTTP framework is private to HTTP and process startup",
    );
  if (
    from.startsWith("src/shared/") &&
    target.startsWith("src/") &&
    !target.startsWith("src/shared/")
  )
    violation(
      from,
      target,
      "Shared UI must not depend on features or composition",
    );
  if (from.startsWith("src/features/") && target.startsWith("src/")) {
    const feature = from.split("/")[2];
    if (
      !target.startsWith("src/shared/") &&
      !target.startsWith(`src/features/${feature}/`)
    )
      violation(
        from,
        target,
        "Features use shared contracts, never another feature's pages",
      );
  }
}
for (const file of [
  ...files(resolve(root, "server")),
  ...files(resolve(root, "src")),
]) {
  const from = normalize(file),
    text = readFileSync(file, "utf8");
  const source = await parsers.typescript.parse(text, { filepath: file });
  const dependencies = [];
  function inspect(node) {
    let specifier;
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
        "ImportExpression",
      ].includes(node.type)
    )
      specifier = node.source?.value;
    if (node.type === "CallExpression" && node.callee?.name === "require")
      specifier = node.arguments[0]?.value;
    if (node.type === "TSImportType") specifier = node.argument?.value;
    if (specifier) {
      const target = resolveImport(file, specifier);
      check(from, target);
      if (target.startsWith("src/") || target.startsWith("server/"))
        dependencies.push(target);
    }
    const literal =
      typeof node.value === "string"
        ? node.value
        : node.type === "TemplateElement"
          ? node.value.raw
          : "";
    if (
      /\b(?:SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|PRAGMA\s)/is.test(
        literal,
      ) &&
      !from.startsWith("server/infrastructure/sqlite/")
    )
      violation(
        from,
        "SQL",
        "Queries and schema belong to SQLite infrastructure",
      );
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        value.forEach((child) => {
          if (child?.type) inspect(child);
        });
      else if (value && typeof value === "object" && value.type) inspect(value);
    }
  }
  inspect(source);
  graph.set(from, dependencies);
}
const completed = new Set(),
  visiting = new Set();
function visit(file, path = []) {
  if (visiting.has(file)) {
    errors.push(`Import cycle: ${[...path, file].join(" -> ")}`);
    return;
  }
  if (completed.has(file)) return;
  visiting.add(file);
  for (const dependency of graph.get(file) ?? [])
    visit(dependency, [...path, file]);
  visiting.delete(file);
  completed.add(file);
}
for (const file of graph.keys()) visit(file);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Architecture checks passed (${graph.size} files; layers, feature boundaries, SQL isolation, no import cycles).`,
  );
