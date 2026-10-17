import { createHash, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { Config } from "./config.js";

export interface AppContext {
  config: Config;
  pool: pg.Pool;
}

/** Constant-time string comparison for secrets. */
export function safeEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
