import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { Membership } from "../modules/membership/application/membership.ts";
import { AccessController } from "../modules/membership/interfaces/http/access.controller.ts";
import { InvitationsController } from "../modules/membership/interfaces/http/invitations.controller.ts";
import { SessionGuard } from "../interfaces/http/session.guard.ts";
import type { Resources } from "./resources.ts";
import { MEMBERS, RUNTIME, SECURITY, SETUP_KEY } from "./tokens.ts";

@Module({})
class MembershipModule {}

export function membershipModule(infrastructure: DynamicModule): DynamicModule {
  return {
    module: MembershipModule,
    imports: [infrastructure],
    controllers: [AccessController, InvitationsController],
    providers: [
      {
        provide: Membership,
        inject: [MEMBERS, RUNTIME, SECURITY, SETUP_KEY],
        useFactory: (
          members: Resources["members"],
          runtime: Resources["runtime"],
          security: Resources["security"],
          setupKey: string,
        ) => new Membership(members, runtime, security, setupKey),
      },
      {
        provide: APP_GUARD,
        inject: [Membership, Reflector],
        useFactory: (members: Membership, reflector: Reflector) =>
          new SessionGuard(members, reflector),
      },
    ],
  };
}
