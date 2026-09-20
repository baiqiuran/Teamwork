import http from "node:http";
import https from "node:https";

// Node's fetch ignores an overridden Host header. Local readiness/recovery
// probes must connect to loopback while preserving the application's origin.
export function read(url, options = {}) {
  const target = new URL(url),
    headers = new Headers(options.headers);
  if (!headers.has("host") || headers.get("host") === target.host)
    return globalThis.fetch(target, options);
  let body = options.body;
  if (body instanceof URLSearchParams) {
    body = body.toString();
    if (!headers.has("content-type"))
      headers.set("content-type", "application/x-www-form-urlencoded");
  }
  return new Promise((resolve, reject) => {
    const request = (target.protocol === "https:" ? https : http).request(
      target,
      {
        method: options.method ?? "GET",
        headers: Object.fromEntries(headers),
        signal: options.signal ?? AbortSignal.timeout(5000),
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 16777216) {
            response.destroy(new Error("PROBE_RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const resultHeaders = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2)
            resultHeaders.append(
              response.rawHeaders[i],
              response.rawHeaders[i + 1],
            );
          resolve(
            new Response(
              [204, 304].includes(response.statusCode)
                ? null
                : Buffer.concat(chunks),
              { status: response.statusCode, headers: resultHeaders },
            ),
          );
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}
