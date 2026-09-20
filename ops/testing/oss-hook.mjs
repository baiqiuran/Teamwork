import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === "./oss.mjs" &&
      context.parentURL?.endsWith("/offsite-cli.mjs")
    )
      return {
        url: new URL("./oss-boundary.mjs", import.meta.url).href,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
