import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
} from "express";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { installJournal } from "./journal.ts";
import { HttpError } from "./http-error.ts";
import { installSharing } from "./sharing.ts";
import {
  digest,
  dummyPasswordHash,
  hashPassword,
  secret,
  verifyPassword,
} from "./security.ts";

export interface AppOptions {
  databasePath: string;
  setupKey: string;
  now?: () => number;
}

const WEEK = 7 * 24 * 60 * 60 * 1000;
const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
});
const registration = credentials.extend({
  name: z.string().trim().min(1).max(60),
});
interface Member {
  id: string;
  name: string;
  email: string;
}
interface Invitation {
  id: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  used_by: string | null;
}

export function createApp(options: AppOptions) {
  const now = options.now ?? Date.now;
  const db = new DatabaseSync(options.databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS team (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, created_by TEXT NOT NULL REFERENCES members(id),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      revoked_at INTEGER, used_by TEXT REFERENCES members(id)
    );
  `);
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { "upgrade-insecure-requests": null },
      },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use("/api", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", (request, _response, next) => {
    const host = request.get("host") ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host))
      throw new HttpError(403, "当前应用仅允许本机访问。");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (request.get("origin") !== `${request.protocol}://${host}`)
        throw new HttpError(403, "请求来源不匹配，请从应用页面重试。");
      if (!request.is("application/json"))
        throw new HttpError(415, "请使用 JSON 请求。");
    }
    next();
  });
  app.use(
    "/api/diaries/:id/entries/:entryId/attachments",
    express.json({ limit: "28mb" }),
  );
  app.use(express.json({ limit: "4mb" }));
  const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "尝试次数过多，请 10 分钟后重试。" },
  });
  app.use(
    ["/api/setup", "/api/login", "/api/join"],
    (request, response, next) =>
      request.method === "POST" ? authLimiter(request, response, next) : next(),
  );

  const team = () => db.prepare("SELECT id, name FROM team WHERE id = 1").get();
  const cookieToken = (request: Request) =>
    (request.headers.cookie ?? "")
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("daily_session="))
      ?.slice(14) ?? "";
  function authenticate(request: Request): Member {
    const member = db
      .prepare(
        `SELECT m.id, m.name, m.email FROM members m JOIN sessions s ON s.member_id = m.id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(digest(cookieToken(request)), now()) as unknown as
      Member | undefined;
    if (!member) throw new HttpError(401, "请先登录。");
    return member;
  }
  function issueSession(response: Response, memberId: string) {
    const token = secret();
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(
      digest(token),
      memberId,
      now() + WEEK,
    );
    response.cookie("daily_session", token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: WEEK,
    });
  }
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function availableInvitation(token: string): Invitation {
    const invitation = db
      .prepare("SELECT * FROM invitations WHERE token_hash = ?")
      .get(digest(token)) as unknown as Invitation | undefined;
    if (
      !invitation ||
      invitation.used_by ||
      invitation.revoked_at !== null ||
      invitation.expires_at <= now()
    ) {
      throw new HttpError(
        410,
        "邀请无效、已过期或已使用，请向团队成员索取新邀请。",
      );
    }
    return invitation;
  }

  app.get("/api/setup/status", (_request, response) => {
    response.json({ needsSetup: !team() });
  });
  app.post("/api/setup", async (request, response) => {
    if (team())
      throw new HttpError(409, "团队已经建立，请登录或使用邀请加入。");
    const input = registration
      .extend({
        teamName: z.string().trim().min(1).max(60),
        setupKey: z.string(),
      })
      .parse(request.body);
    const remote = request.socket.remoteAddress;
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote ?? "") ||
      digest(input.setupKey) !== digest(options.setupKey)
    ) {
      throw new HttpError(403, "请使用本机启动时提供的引导密钥。");
    }
    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();
    transaction(() => {
      if (team()) throw new HttpError(409, "团队已经建立。");
      db.prepare("INSERT INTO team VALUES (1, ?)").run(input.teamName);
      db.prepare("INSERT INTO members VALUES (?, ?, ?, ?, ?)").run(
        id,
        input.name,
        input.email,
        passwordHash,
        now(),
      );
      issueSession(response, id);
    });
    response.status(201).json({
      member: { id, name: input.name, email: input.email },
      team: team(),
    });
  });
  app.get("/api/me", (request, response) => {
    response.json({ member: authenticate(request), team: team() });
  });

  app.post("/api/login", async (request, response) => {
    const input = credentials.parse(request.body);
    const member = db
      .prepare(
        "SELECT id, name, email, password_hash FROM members WHERE email = ?",
      )
      .get(input.email);
    const valid = await verifyPassword(
      input.password,
      member ? String(member.password_hash) : dummyPasswordHash,
    );
    if (!member || !valid) throw new HttpError(401, "邮箱或密码不正确。");
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(
      digest(cookieToken(request)),
    );
    issueSession(response, String(member.id));
    response.json({
      member: { id: member.id, name: member.name, email: member.email },
      team: team(),
    });
  });
  app.post("/api/logout", (request, response) => {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(
      digest(cookieToken(request)),
    );
    response.clearCookie("daily_session", {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
    response.json({ ok: true });
  });

  app.post("/api/invitations", (request, response) => {
    const member = authenticate(request);
    const id = randomUUID();
    const token = secret();
    const expiresAt = now() + WEEK;
    db.prepare(
      "INSERT INTO invitations (id, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, digest(token), member.id, now(), expiresAt);
    response.status(201).json({
      invitation: { id, expiresAt },
      token,
      joinPath: `/join#invite=${token}`,
    });
  });
  app.get("/api/invitations", (request, response) => {
    const member = authenticate(request);
    const invitations = db
      .prepare(
        "SELECT id, created_by, created_at, expires_at, revoked_at, used_by FROM invitations WHERE created_by = ? ORDER BY created_at DESC, rowid DESC",
      )
      .all(member.id) as unknown as Invitation[];
    response.json({
      invitations: invitations.map((invitation) => ({
        id: invitation.id,
        createdBy: invitation.created_by,
        createdAt: invitation.created_at,
        expiresAt: invitation.expires_at,
        status: invitation.used_by
          ? "used"
          : invitation.revoked_at !== null
            ? "revoked"
            : invitation.expires_at <= now()
              ? "expired"
              : "active",
      })),
    });
  });
  app.post("/api/invitations/preview", (request, response) => {
    const { token } = z
      .object({ token: z.string().min(1).max(128) })
      .parse(request.body);
    const invitation = availableInvitation(token);
    const inviter = db
      .prepare("SELECT name FROM members WHERE id = ?")
      .get(invitation.created_by)!;
    response.json({
      team: team(),
      invitedBy: inviter.name,
      expiresAt: invitation.expires_at,
    });
  });
  app.post("/api/invitations/:id/revoke", (request, response) => {
    const member = authenticate(request);
    const id = z.uuid().parse(request.params.id);
    const invitation = db
      .prepare("SELECT * FROM invitations WHERE id = ?")
      .get(id) as unknown as Invitation | undefined;
    if (!invitation) throw new HttpError(404, "未找到邀请。");
    if (invitation.created_by !== member.id)
      throw new HttpError(403, "只能撤销自己生成的邀请。");
    if (invitation.used_by)
      throw new HttpError(409, "邀请已被接受，不能撤销成员资格。");
    db.prepare(
      "UPDATE invitations SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
    ).run(now(), id);
    response.json({ ok: true });
  });
  app.post("/api/join", async (request, response) => {
    const input = registration
      .extend({ token: z.string().min(1).max(128) })
      .parse(request.body);
    availableInvitation(input.token);
    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();
    transaction(() => {
      const invitation = availableInvitation(input.token);
      if (db.prepare("SELECT id FROM members WHERE email = ?").get(input.email))
        throw new HttpError(409, "此邮箱已注册，请直接登录。");
      db.prepare("INSERT INTO members VALUES (?, ?, ?, ?, ?)").run(
        id,
        input.name,
        input.email,
        passwordHash,
        now(),
      );
      db.prepare("UPDATE invitations SET used_by = ? WHERE id = ?").run(
        id,
        invitation.id,
      );
      issueSession(response, id);
    });
    response.status(201).json({
      member: { id, name: input.name, email: input.email },
      team: team(),
    });
  });

  installJournal(
    app,
    { db, now, authenticate, transaction },
    resolve(dirname(options.databasePath), "attachments"),
  );
  installSharing(app, { db, now, authenticate, transaction });
  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "未找到该接口。" });
  });
  const errorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({
        error: "请检查输入内容及长度限制。",
      });
      return;
    }
    if (error instanceof HttpError) {
      response
        .status(error.status)
        .json({ error: error.message, details: error.details });
      return;
    }
    if (error instanceof SyntaxError) {
      response.status(400).json({ error: "请求格式不正确。" });
      return;
    }
    console.error("Request failed:", error);
    response.status(500).json({ error: "操作未完成，请稍后重试。" });
  };
  app.use(errorHandler);
  return {
    app,
    close() {
      db.close();
    },
  };
}
