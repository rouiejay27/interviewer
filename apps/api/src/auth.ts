import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sha256, type AppContext } from "./context.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const COOKIE_NAME = "iv_rs";

/** Random URL-safe token (256 bits). Only its SHA-256 hash is ever stored. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, saltB64, hashB64] = stored.split("$");
  if (kind !== "scrypt" || !n || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64url");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64url"), expected.length, { ...SCRYPT, N: Number(n) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function sessionCookie(req: FastifyRequest, token: string, maxAgeSeconds: number): string {
  // Secure only over HTTPS (Railway); plain http://127.0.0.1 during local development.
  const secure = req.protocol === "https" ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

export interface Recruiter {
  id: string;
  email: string;
  display_name: string;
}

declare module "fastify" {
  interface FastifyRequest {
    recruiter?: Recruiter;
  }
}

/** preHandler: rejects the request unless it carries a valid recruiter login cookie. */
export function requireRecruiter(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = readCookie(req, COOKIE_NAME);
    if (!token) return reply.code(401).send({ error: "Please log in." });
    const row = await ctx.pool.query<Recruiter>(
      `SELECT r.id, r.email, r.display_name FROM recruiter_sessions s
       JOIN recruiters r ON r.id = s.recruiter_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );
    const recruiter = row.rows[0];
    if (!recruiter) return reply.code(401).send({ error: "Your login expired. Please log in again." });
    req.recruiter = recruiter;
  };
}

/** Small in-memory limiter for login attempts (per IP). Enough for a single-instance deployment. */
export class AttemptLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    // Bound memory: drop keys whose attempts are all outside the window.
    if (this.hits.size > 5000) {
      for (const [k, times] of this.hits) if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

/** Writes an access log row. Never pass applicant content here. */
export async function audit(
  ctx: AppContext,
  entry: { actorType: "recruiter" | "applicant" | "system"; actorId?: string; action: string; targetType?: string; targetId?: string },
): Promise<void> {
  await ctx.pool.query(
    "INSERT INTO access_log (actor_type, actor_id, action, target_type, target_id) VALUES ($1, $2, $3, $4, $5)",
    [entry.actorType, entry.actorId ?? null, entry.action, entry.targetType ?? null, entry.targetId ?? null],
  );
}
