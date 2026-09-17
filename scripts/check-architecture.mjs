import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsers } from "prettier/plugins/typescript";
import {
  dependencyViolations,
  dependencyCycles,
  isSqlite,
} from "./architecture-rules.mjs";

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
      const typeOnly =
        node.importKind === "type" ||
        node.exportKind === "type" ||
        node.type === "TSImportType" ||
        (node.specifiers?.length > 0 &&
          node.specifiers.every(
            (s) => s.importKind === "type" || s.exportKind === "type",
          ));
      for (const rule of dependencyViolations(from, target, typeOnly))
        violation(from, target, rule);
      if (specifier.startsWith(".") && !existsSync(resolve(root, target)))
        violation(
          from,
          target,
          "Relative import must resolve to a source file",
        );
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
      !isSqlite(from)
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
errors.push(...dependencyCycles(graph));
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Architecture checks passed (${graph.size} files; module ownership, layers, feature boundaries, SQL isolation, no import cycles).`,
  );
