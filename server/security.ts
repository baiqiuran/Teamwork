import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const secret = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(":");
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

export const dummyPasswordHash = `${"0".repeat(32)}:${"0".repeat(128)}`;
