import type {
  McpServer,
  CallToolResult,
  ToolAnnotations,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
import { toolResult } from "./mcp-result.ts";

/** Keep advertised schemas strict while translating validation failures to the
 * same redacted business error/audit contract as failures inside a use case. */
export class McpTools {
  constructor(
    private readonly server: McpServer,
    private readonly invalidWrite: (tool: string) => void,
  ) {}
  registerTool<S extends z.ZodType>(
    name: string,
    definition: {
      description: string;
      inputSchema: S;
      annotations?: ToolAnnotations;
    },
    callback: (input: z.output<S>) => CallToolResult | Promise<CallToolResult>,
  ) {
    const schema = definition.inputSchema;
    const inputSchema: StandardSchemaWithJSON<
      unknown,
      z.ZodSafeParseResult<z.output<S>>
    > = {
      "~standard": {
        version: 1 as const,
        vendor: "daily-flow",
        jsonSchema: schema["~standard"].jsonSchema,
        validate: (raw: unknown) => ({ value: schema.safeParse(raw) }),
      },
    };
    this.server.registerTool(name, { ...definition, inputSchema }, (parsed) => {
      if (!parsed.success) {
        if (definition.annotations?.readOnlyHint === false)
          this.invalidWrite(name);
        return toolResult(() => {
          throw parsed.error;
        });
      }
      return callback(parsed.data);
    });
  }
}
