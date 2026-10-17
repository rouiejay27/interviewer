import { describe, expect, it } from "vitest";
import { AttemptLimiter, hashPassword, newToken, verifyPassword } from "../src/auth.js";
import { redactUrl } from "../src/logging.js";

describe("passwords", () => {
  it("hashes with a salt and verifies", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("wrong", a)).toBe(false);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });
});

describe("tokens", () => {
  it("are 43 URL-safe characters and unique", () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(t);
  });
});

describe("AttemptLimiter", () => {
  it("blocks after the limit and recovers after the window", () => {
    const l = new AttemptLimiter(2, 1000);
    expect(l.allow("ip", 0)).toBe(true);
    expect(l.allow("ip", 10)).toBe(true);
    expect(l.allow("ip", 20)).toBe(false);
    expect(l.allow("other", 20)).toBe(true);
    expect(l.allow("ip", 1500)).toBe(true);
  });
});

describe("log redaction", () => {
  it("never logs applicant link tokens or query strings", () => {
    expect(redactUrl("/i/AbC123_-xyz")).toBe("/i/[link]");
    expect(redactUrl("/api/applicant/AbC123/start")).toBe("/api/applicant/[link]/start");
    expect(redactUrl("/webhooks/tavus?token=secret")).toBe("/webhooks/tavus");
    expect(redactUrl("/api/vacancies/123")).toBe("/api/vacancies/123");
  });
});
