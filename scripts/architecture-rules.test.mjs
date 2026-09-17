import test from "node:test";
import assert from "node:assert/strict";
import {
  dependencyViolations,
  dependencyCycles,
  isSqlite,
} from "./architecture-rules.mjs";

test("domain ownership rejects reversed task/diary dependency and outward framework calls", () => {
  const work = "server/modules/work/domain/work.ts";
  assert.ok(
    dependencyViolations(work, "server/modules/journal/domain/diary.ts", true)
      .length,
  );
  assert.ok(dependencyViolations(work, "@nestjs/common").length);
  assert.ok(
    dependencyViolations(work, "server/modules/work/application/work.ts")
      .length,
  );
  assert.deepEqual(
    dependencyViolations(
      "server/modules/journal/domain/diary.ts",
      "server/modules/work/domain/task-status.ts",
    ),
    [],
  );
  assert.ok(dependencyViolations("server/shared/domain/date.ts", work).length);
});

test("adapters can implement typed owned ports but cannot call business use cases or foreign persistence", () => {
  const repo = "server/modules/work/infrastructure/sqlite/work-repository.ts";
  assert.deepEqual(
    dependencyViolations(
      repo,
      "server/modules/work/application/ports.ts",
      true,
    ),
    [],
  );
  assert.ok(
    dependencyViolations(repo, "server/modules/work/application/ports.ts")
      .length,
  );
  assert.ok(
    dependencyViolations(repo, "server/modules/work/application/work.ts", true)
      .length,
  );
  assert.ok(
    dependencyViolations(
      repo,
      "server/modules/journal/infrastructure/sqlite/diary-repository.ts",
    ).length,
  );
  assert.ok(
    dependencyViolations(
      "server/modules/work/interfaces/http/work.controller.ts",
      repo,
    ).length,
  );
  assert.ok(
    dependencyViolations(
      "server/modules/ai/application/ai-work.ts",
      "@modelcontextprotocol/server",
    ).length,
  );
});

test("application orchestration uses declared module interfaces, with private helpers protected", () => {
  const ai = "server/modules/ai/application/ai-journal.ts";
  assert.deepEqual(
    dependencyViolations(ai, "server/modules/journal/application/journal.ts"),
    [],
  );
  assert.deepEqual(
    dependencyViolations(
      ai,
      "server/modules/journal/application/ports.ts",
      true,
    ),
    [],
  );
  assert.ok(
    dependencyViolations(
      ai,
      "server/modules/journal/application/attachment-references.ts",
    ).length,
  );
  assert.ok(
    dependencyViolations(
      "server/modules/ai/interfaces/http/ai.controller.ts",
      "server/modules/journal/application/journal.ts",
    ).length,
  );
  assert.ok(
    dependencyViolations(
      "src/features/ai/AiConnections.tsx",
      "src/features/membership/Account.tsx",
    ).length,
  );
  assert.deepEqual(
    dependencyViolations(
      "src/features/ai/AiConnections.tsx",
      "src/shared/api.ts",
    ),
    [],
  );
  assert.ok(
    dependencyViolations(
      "src/shared/api.ts",
      "server/modules/journal/application/journal.ts",
    ).length,
  );
});

test("SQL is restricted to migration and repository adapters; real dependency cycles fail", () => {
  assert.equal(isSqlite("server/infrastructure/sqlite/database.ts"), true);
  assert.equal(
    isSqlite("server/modules/work/infrastructure/sqlite/work-repository.ts"),
    true,
  );
  assert.equal(
    isSqlite("server/modules/work/application/sqlite/query.ts"),
    false,
  );
  assert.ok(
    dependencyViolations(
      "server/modules/work/application/work.ts",
      "node:sqlite",
    ).length,
  );
  assert.equal(
    dependencyCycles(
      new Map([
        ["a", ["b"]],
        ["b", []],
      ]),
    ).length,
    0,
  );
  assert.equal(
    dependencyCycles(
      new Map([
        ["a", ["b"]],
        ["b", ["a"]],
      ]),
    ).length,
    1,
  );
});
