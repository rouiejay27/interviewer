import { z } from "zod";

const boolFromString = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  // 127.0.0.1 keeps the server off the office/home network; the tunnel still reaches it. Use 0.0.0.0 on a cloud host.
  HOST: z.string().default("127.0.0.1"),
  PUBLIC_BASE_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
  // Pooled connection (Neon "-pooler" host) for application traffic.
  DATABASE_URL: z.string().min(1),
  // Direct connection for schema migrations. Falls back to DATABASE_URL when unset.
  DATABASE_URL_UNPOOLED: z.string().optional().transform((v) => (v ? v : undefined)),

  TAVUS_API_KEY: z.string().min(1),
  TAVUS_BASE_URL: z.url().default("https://tavusapi.com"),
  // Needed only by `npm run create-pal`; the server starts without it.
  TAVUS_FACE_ID: z.string().optional().default(""),
  TAVUS_PAL_ID: z.string().optional().default(""),
  TAVUS_TEST_MODE: boolFromString,

  XAI_API_KEY: z.string().min(1),
  XAI_BASE_URL: z.url().default("https://api.x.ai/v1"),
  XAI_LIVE_MODEL: z.string().default("grok-4.20-0309-non-reasoning"),

  LLM_PROXY_SECRET: z.string().min(24, "LLM_PROXY_SECRET must be at least 24 characters"),
  WEBHOOK_SECRET: z.string().min(24, "WEBHOOK_SECRET must be at least 24 characters"),
  POC_ACCESS_TOKEN: z.string().min(12, "POC_ACCESS_TOKEN must be at least 12 characters"),

  MAX_CALL_SECONDS: z.coerce.number().int().min(60).max(3600).default(290),
});

export type Config = z.infer<typeof EnvSchema>;

export function tavusAuth(config: Config): { apiKey: string; baseUrl: string } {
  return { apiKey: config.TAVUS_API_KEY, baseUrl: config.TAVUS_BASE_URL.replace(/\/+$/, "") };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid or missing settings in .env:\n${problems}\nCopy .env.example to .env and fill it in.`,
    );
  }
  return parsed.data;
}

/** Shows only the first 4 characters of a secret, for logs. */
export function mask(secret: string): string {
  return secret.length <= 4 ? "****" : `${secret.slice(0, 4)}****`;
}
