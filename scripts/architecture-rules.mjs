const domainDependencies = {
  membership: [],
  work: [],
  attachments: [],
  journal: ["work", "attachments"],
  sharing: ["journal"],
  ai: [],
};
// Explicit public application entry points; helper files remain module-private.
const applicationExports = {
  membership: ["membership.ts", "ports.ts"],
  work: ["work.ts", "ports.ts"],
  journal: ["journal.ts", "reading.ts", "ports.ts"],
  sharing: ["sharing.ts", "ports.ts"],
  attachments: ["attachments.ts", "ports.ts"],
  ai: ["ports.ts"],
};
export function layerOf(path) {
  const module =
    /^server\/modules\/([^/]+)\/(domain|application|infrastructure|interfaces)\//.exec(
      path,
    );
  if (module) return { owner: module[1], layer: module[2] };
  const shared =
    /^server\/(?:shared\/)?(domain|application|infrastructure|interfaces)\//.exec(
      path,
    );
  return shared ? { owner: "shared", layer: shared[1] } : {};
}
export const isSqlite = (path) =>
  /^server\/(?:modules\/[^/]+\/)?infrastructure\/sqlite\//.test(path);
export function dependencyViolations(from, target, typeOnly = false) {
  const errors = [];
  const source = layerOf(from),
    destination = layerOf(target);
  const localServer = target.startsWith("server/");
  const crossModule =
    source.owner &&
    destination.owner &&
    source.owner !== destination.owner &&
    destination.owner !== "shared";
  if (/^server\/(domain|application)\//.test(from))
    errors.push(
      "Business code belongs to an owning module or the shared kernel",
    );
  if (
    from.startsWith("server/modules/") &&
    !Object.hasOwn(domainDependencies, source.owner)
  )
    errors.push("Business module must have declared ownership");
  if (
    (from.startsWith("server/") && target.startsWith("src/")) ||
    (from.startsWith("src/") && localServer)
  )
    errors.push("Client and server communicate through HTTP contracts");
  if (source.layer === "domain") {
    if (destination.layer !== "domain" && target !== "zod")
      errors.push("Domain depends only on domain rules and pure validation");
    if (
      crossModule &&
      !(domainDependencies[source.owner] ?? []).includes(destination.owner)
    )
      errors.push(
        "Domain dependency is not part of the declared business model",
      );
  }
  if (
    from.startsWith("server/shared/") &&
    localServer &&
    !target.startsWith("server/shared/")
  )
    errors.push(
      "Shared kernel must not depend on business modules or adapters",
    );
  if (source.layer === "application") {
    if (
      !["domain", "application"].includes(destination.layer) &&
      target !== "zod"
    )
      errors.push(
        "Application depends on domain, use cases, ports and pure input validation",
      );
    if (
      crossModule &&
      destination.layer === "application" &&
      !(applicationExports[destination.owner] ?? []).some(
        (file) =>
          target === `server/modules/${destination.owner}/application/${file}`,
      )
    )
      errors.push(
        "Cross-module calls must use a declared application interface",
      );
  }
  if (source.layer === "infrastructure" && localServer) {
    const ownOrShared = !crossModule;
    const port =
      destination.layer === "application" &&
      target.endsWith("/ports.ts") &&
      typeOnly;
    if (
      !ownOrShared ||
      (!["domain", "infrastructure"].includes(destination.layer) && !port)
    )
      errors.push(
        "Infrastructure implements its own typed ports, never use cases or another module's adapters",
      );
  }
  if (source.layer === "interfaces" && localServer) {
    if (!["domain", "application", "interfaces"].includes(destination.layer))
      errors.push("Interfaces must not select infrastructure or composition");
    if (
      crossModule &&
      source.owner !== "shared" &&
      ["interfaces", "application"].includes(destination.layer)
    )
      errors.push(
        "Module interfaces call their own application; cross-module orchestration belongs in application",
      );
  }
  if (target === "node:sqlite" && !isSqlite(from))
    errors.push("SQLite is private to infrastructure");
  if (
    (["express", "helmet", "express-rate-limit"].includes(target) ||
      target.startsWith("@nestjs/") ||
      target.startsWith("@modelcontextprotocol/")) &&
    source.layer !== "interfaces" &&
    !from.startsWith("server/composition/") &&
    !["server/app.ts", "server/main.ts"].includes(from)
  )
    errors.push("Frameworks belong to protocol adapters and composition");
  if (
    from.startsWith("src/shared/") &&
    target.startsWith("src/") &&
    !target.startsWith("src/shared/")
  )
    errors.push("Shared UI must not depend on features or composition");
  if (
    from.startsWith("src/features/") &&
    target.startsWith("src/") &&
    !target.startsWith("src/shared/") &&
    !target.startsWith(`src/features/${from.split("/")[2]}/`)
  )
    errors.push("Features use shared contracts, never another feature's pages");
  return errors;
}

export function dependencyCycles(graph) {
  const errors = [],
    completed = new Set(),
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
  return errors;
}
