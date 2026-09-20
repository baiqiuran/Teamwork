import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { sha256 } from "./io.mjs";
export async function intent(action, options) {
  const candidate = options["--candidate"]
    ? resolve(options["--candidate"])
    : undefined;
  let materials;
  if (action === "release") {
    materials = {};
    for (const name of [
      "application.tar.gz",
      "receipt.json",
      "upgrade.json",
      "plan.json",
    ])
      materials[name] = await sha256(resolve(candidate, name));
  }
  const value = {
    action,
    kind:
      action === "release" ? "pre-release" : (options["--kind"] ?? "manual"),
    candidate,
    baseline: options["--baseline"],
    snapshot: options["--snapshot"],
    incident: options["--incident"],
    expectedCommit: options["--expected-commit"],
    note: options["--note"],
    materials,
  };
  return {
    fingerprint: createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex"),
    materials,
  };
}
