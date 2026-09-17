import type { CreateShareInput, CloseShareInput } from "./command-contracts.ts";
import type { PageInput } from "./query-contracts.ts";
import type { Sharing } from "../../sharing/application/sharing.ts";
import type { AiOperations, AiAccess } from "./ai-operations.ts";
import type { AiAuthorization } from "./ai-authorization.ts";
import type { AiReading } from "./ai-reading.ts";
export class AiSharing {
  constructor(
    private readonly sharing: Sharing,
    private readonly operations: AiOperations,
    private readonly auth: AiAuthorization,
    private readonly reading: AiReading,
  ) {}
  create(access: AiAccess, input: CreateShareInput) {
    return this.operations.run(
      access,
      "create_share",
      input,
      ["shares:manage"],
      (memberId) => {
        const share = this.sharing.create(memberId, input);
        return {
          result: {
            share: { ...share, url: new URL(share.path, access.resource).href },
            publicScope:
              input.type === "diary"
                ? "所选日期内全团队完整已提交日报"
                : "所选对象与模块",
          },
          objectId: share.id,
        };
      },
    );
  }
  close(access: AiAccess, input: CloseShareInput) {
    return this.operations.run(
      access,
      "close_share",
      input,
      ["shares:manage"],
      (memberId) => {
        this.sharing.close(input.id, memberId);
        return { result: { closed: true }, objectId: input.id };
      },
    );
  }
  list(access: AiAccess, input: PageInput & { closed?: boolean }) {
    return this.auth.authorized(
      access.token,
      access.resource,
      ["shares:manage"],
      ({ member }) =>
        this.reading.page(
          this.sharing
            .mine(member.id)
            .filter(
              (share) =>
                input.closed === undefined || share.closed === input.closed,
            )
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((share) => ({
              ...share,
              url: new URL(share.path, access.resource).href,
            })),
          input,
          { tool: "my-shares", memberId: member.id, closed: input.closed },
        ),
    );
  }
}
