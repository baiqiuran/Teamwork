import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { AiKeyCipher } from "../application/ports.ts";

// Only this adapter knows the master-file and authenticated envelope formats.
export function aiKeyCipher(masterFile?: string): AiKeyCipher {
  const unavailable = () => {
    throw new Error("成员 Key 加密服务不可用。");
  };
  if (masterFile === undefined) return { seal: unavailable, open: unavailable };
  let master: Buffer;
  let descriptor: number | undefined;
  const bytes = Buffer.alloc(65);
  try {
    if (!isAbsolute(masterFile)) throw new Error();
    const path = realpathSync(masterFile);
    const fromApplication = relative(realpathSync(process.cwd()), path);
    if (
      fromApplication !== ".." &&
      !fromApplication.startsWith(`..${sep}`) &&
      !isAbsolute(fromApplication)
    )
      throw new Error();
    descriptor = openSync(path, "r");
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size !== 65 ||
      readSync(descriptor, bytes, 0, 65, 0) !== 65
    )
      throw new Error();
    const text = bytes.toString("ascii");
    if (
      !/^[0-9a-f]{64}\n$/.test(text) ||
      !Buffer.from(text, "ascii").equals(bytes)
    )
      throw new Error();
    master = Buffer.from(text.slice(0, 64), "hex");
  } catch {
    throw new Error(
      "DAILY_AI_KEY_MASTER_FILE 无效：须为应用目录外可读的绝对路径，文件须含 64 位小写十六进制主密钥及一个 LF 换行。",
    );
  } finally {
    bytes.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return {
    seal(key, grantId) {
      if (!/^dfk_[A-Za-z0-9_-]{43}$/.test(key)) return unavailable();
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", master, nonce);
      cipher.setAAD(Buffer.from(grantId, "utf8"));
      const ciphertext = Buffer.concat([
        cipher.update(key, "utf8"),
        cipher.final(),
      ]);
      return [
        "v1",
        nonce.toString("base64url"),
        ciphertext.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
      ].join(".");
    },
    open(envelope, grantId) {
      let partial: Buffer | undefined;
      let plaintext: Buffer | undefined;
      try {
        if (
          envelope.length !== 106 ||
          !/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{63}\.[A-Za-z0-9_-]{22}$/.test(
            envelope,
          )
        )
          return unavailable();
        const parts = envelope.split(".").slice(1);
        const [nonce, ciphertext, tag] = parts.map((part) =>
          Buffer.from(part, "base64url"),
        );
        if (
          [nonce, ciphertext, tag].some(
            (value, index) => value.toString("base64url") !== parts[index],
          )
        )
          return unavailable();
        const decipher = createDecipheriv("aes-256-gcm", master, nonce, {
          authTagLength: 16,
        });
        decipher.setAAD(Buffer.from(grantId, "utf8"));
        decipher.setAuthTag(tag);
        partial = decipher.update(ciphertext);
        // final() authenticates before any plaintext can leave this adapter.
        plaintext = Buffer.concat([partial, decipher.final()]);
        const key = plaintext.toString("utf8");
        if (!/^dfk_[A-Za-z0-9_-]{43}$/.test(key)) return unavailable();
        return key;
      } catch {
        return unavailable();
      } finally {
        partial?.fill(0);
        plaintext?.fill(0);
      }
    },
  };
}
