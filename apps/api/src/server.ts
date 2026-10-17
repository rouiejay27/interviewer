import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { loadConfig, mask } from "./config.js";
import type { AppContext } from "./context.js";
import { createPool, migrate } from "./db.js";
import { registerLlmRoutes } from "./routes/llm.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { startSweeper } from "./sweeper.js";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const ctx: AppContext = { config, pool };

const app = Fastify({
  logger: {
    level: "info",
    // Never write secrets or applicant text to routine logs.
    redact: ["req.headers.authorization", "req.headers['x-api-key']", "req.headers['x-poc-token']"],
    serializers: {
      // Drop query strings from logged URLs: the webhook URL carries a secret token.
      req: (req: { method: string; url: string; ip?: string }) => ({
        method: req.method,
        url: req.url.split("?")[0],
        ip: req.ip,
      }),
    },
  },
  bodyLimit: 2 * 1024 * 1024,
});

await app.register(fastifyStatic, {
  root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public"),
});

app.get("/api/health", async () => {
  const started = performance.now();
  const db = await pool.query<{ database: string; migrations: number }>(
    "SELECT current_database() AS database, (SELECT count(*)::int FROM schema_migrations) AS migrations",
  );
  return {
    ok: true,
    database: db.rows[0]?.database,
    migrationsApplied: db.rows[0]?.migrations,
    dbRoundTripMs: Math.round(performance.now() - started),
    palConfigured: Boolean(config.TAVUS_PAL_ID),
    testMode: config.TAVUS_TEST_MODE,
  };
});

registerLlmRoutes(app, ctx);
registerSessionRoutes(app, ctx);
registerWebhookRoutes(app, ctx);

// Migrations use the direct (unpooled) connection, as Neon recommends for schema changes.
const migrationPool = createPool(config.DATABASE_URL_UNPOOLED ?? config.DATABASE_URL, 1);
const applied = await migrate(migrationPool);
await migrationPool.end();
if (applied.length) app.log.info({ applied }, "database migrations applied");

const stopSweeper = startSweeper(ctx, app.log);

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(
  {
    publicBaseUrl: config.PUBLIC_BASE_URL,
    liveModel: config.XAI_LIVE_MODEL,
    tavusKey: mask(config.TAVUS_API_KEY),
    palId: config.TAVUS_PAL_ID || "(not set)",
  },
  "iNTERVIEWER PoC API ready",
);

const shutdown = async () => {
  stopSweeper();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
