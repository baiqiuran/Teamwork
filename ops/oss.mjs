import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { destination } from "./offsite.mjs";
const require = createRequire(import.meta.url);

export async function createStore(config) {
  destination(config);
  const OSS = require("ali-oss");
  const Credential = require("@alicloud/credentials");
  const credentials = new Credential.default(
    new Credential.Config({
      type: "ecs_ram_role",
      roleName: config.oss.roleName,
      disableIMDSv1: true,
    }),
  );
  const refresh = async () => {
    const c = await credentials.getCredential();
    return {
      accessKeyId: c.accessKeyId,
      accessKeySecret: c.accessKeySecret,
      stsToken: c.securityToken,
    };
  };
  let client;
  return {
    async check() {
      client ??= new OSS({
        ...(await refresh()),
        region: `oss-${config.oss.region}`,
        bucket: config.oss.bucket,
        secure: true,
        authorizationV4: true,
        refreshSTSToken: refresh,
        refreshSTSTokenInterval: 0,
        timeout: 120000,
      });
      assert.equal(
        (await client.getBucketACL(config.oss.bucket)).acl,
        "private",
        "OSS_BUCKET_NOT_PRIVATE",
      );
    },
    async put(key, file) {
      await client.put(key, file, {
        headers: {
          "x-oss-server-side-encryption": "AES256",
          "x-oss-object-acl": "private",
        },
      });
    },
    async digest(key) {
      const { stream, res } = await client.getStream(key);
      if (res.headers["x-oss-server-side-encryption"] !== "AES256") {
        stream.destroy();
        throw new Error("OSS_ENCRYPTION_MISSING");
      }
      const hash = createHash("sha256");
      for await (const chunk of stream) hash.update(chunk);
      return hash.digest("hex");
    },
    async get(key, path) {
      const result = await client.get(key, path);
      assert.equal(
        result.res.headers["x-oss-server-side-encryption"],
        "AES256",
        "OSS_ENCRYPTION_MISSING",
      );
    },
    async remove(key) {
      await client.delete(key);
    },
    async lock() {
      const token = randomUUID();
      await client.put(
        `${config.oss.prefix}coordination/lock.json`,
        Buffer.from(token),
        {
          headers: {
            "x-oss-forbid-overwrite": "true",
            "x-oss-server-side-encryption": "AES256",
            "x-oss-object-acl": "private",
          },
        },
      );
      return token;
    },
    async unlock(token) {
      const key = `${config.oss.prefix}coordination/lock.json`;
      assert.equal(
        (await client.get(key)).content.toString(),
        token,
        "REMOTE_LOCK_CHANGED",
      );
      await client.delete(key);
    },
    async list(prefix) {
      const result = [];
      let token;
      do {
        const page = await client.listV2({
          prefix,
          "continuation-token": token,
          "max-keys": 1000,
        });
        result.push(...(page.objects ?? []).map((x) => x.name));
        token = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (token);
      return result;
    },
  };
}
