import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { db } from "./db.js";

export interface AuthUser {
  id: number;
  username: string;
  role: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

const hashPassword = (password: string, salt: string) =>
  crypto.scryptSync(password, salt, 64).toString("hex");

const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const cookies = (req: Request) => {
  const result: Record<string, string> = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1));
  }
  return result;
};

export const createUser = (username: string, password: string, role = "admin") => {
  const salt = crypto.randomBytes(16).toString("hex");
  return db.prepare(
    "INSERT INTO users(username,password_hash,salt,role) VALUES(?,?,?,?)"
  ).run(username, hashPassword(password, salt), salt, role);
};

export const verifyUser = (username: string, password: string): AuthUser | null => {
  const row = db.prepare(
    "SELECT id,username,password_hash,salt,role FROM users WHERE username=?"
  ).get(username) as { id: number; username: string; password_hash: string; salt: string; role: string } | undefined;
  if (!row) return null;
  const actual = Buffer.from(hashPassword(password, row.salt), "hex");
  const expected = Buffer.from(row.password_hash, "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  return { id: row.id, username: row.username, role: row.role };
};

export const startSession = (userId: number) => {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  db.prepare("DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP").run();
  db.prepare("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,?)")
    .run(userId, tokenHash(token), expires.toISOString());
  return { token, expires };
};

export const endSession = (req: Request) => {
  const token = cookies(req).power_session;
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(token));
};

export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = cookies(req).power_session;
  if (!token) return res.status(401).json({ error: "请先登录" });
  const user = db.prepare(`
    SELECT u.id,u.username,u.role FROM sessions s
    JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at > CURRENT_TIMESTAMP
  `).get(tokenHash(token)) as AuthUser | undefined;
  if (!user) return res.status(401).json({ error: "登录已过期，请重新登录" });
  req.user = user;
  next();
};

export const assignUnownedBatches = (userId: number) =>
  db.prepare("UPDATE import_batches SET owner_user_id=? WHERE owner_user_id IS NULL").run(userId);
