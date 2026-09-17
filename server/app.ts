import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  ExpressAdapter,
  type NestExpressApplication,
} from "@nestjs/platform-express";
import type { Server } from "node:http";
import { createResources, type AppOptions } from "./composition/resources.ts";
import { applicationModule } from "./composition/application.module.ts";
import { configureHttp } from "./interfaces/http/http-app.ts";
import { HttpExceptionFilter } from "./interfaces/http/exception.filter.ts";
import { staticSite } from "./interfaces/http/static-site.ts";

export async function createApp(options: AppOptions) {
  const resources = createResources(options);
  let app: NestExpressApplication | undefined;
  try {
    app = await NestFactory.create<NestExpressApplication>(
      applicationModule(resources),
      new ExpressAdapter(),
      {
        bodyParser: false,
        logger: false,
        abortOnError: false,
        forceCloseConnections: true,
      },
    );
    const http = app.getHttpAdapter().getInstance();
    configureHttp(http, options.publicUrl, options.mcpMaxBodyBytes);
    if (options.staticDirectory) staticSite(http, options.staticDirectory);
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    const application = app;
    let closing: Promise<void> | undefined;
    return {
      needsSetup: () => !resources.members.team(),
      listen: (port: number, host = "127.0.0.1"): Promise<Server> =>
        application.listen(port, host),
      close: () =>
        (closing ??= (async () => {
          try {
            await application.close();
          } finally {
            resources.close();
          }
        })()),
    };
  } catch (error) {
    try {
      await app?.close();
    } finally {
      resources.close();
    }
    throw error;
  }
}
