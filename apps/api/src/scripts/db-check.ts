/**
 * End-to-end database check: connects with both connection strings, applies migrations
 * over the direct connection, then writes, reads, and deletes a test row over the pooled one.
 * Leaves no data behind. Run: npm run db:check
 */
import { randomUUID } from "node:crypto";
import { createPool, migrate } from "../db.js";

const pooledUrl = process.env.DATABASE_URL;
const directUrl = process.env.DATABASE_URL_UNPOOLED || pooledUrl;
if (!pooledUrl) {
  console.error("DATABASE_URL is empty in .env");
  process.exit(1);
}
const host = (url: string) => new URL(url).host;

const direct = createPool(directUrl!, 1);
const pooled = createPool(pooledUrl, 2);
let failed = false;
const step = async (name: string, fn: () => Promise<string>) => {
  const t = performance.now();
  try {
    const detail = await fn();
    console.log(`PASS  ${name} (${Math.round(performance.now() - t)} ms) ${detail}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL  ${name}: ${(err as Error).message}`);
  }
};

console.log(`pooled host: ${host(pooledUrl)}\ndirect host: ${host(directUrl!)}\n`);
await step("connect (direct)", async () => (await direct.query("SELECT version()")).rows[0].version.split(" ").slice(0, 2).join(" "));
await step("apply migrations (direct)", async () => {
  const applied = await migrate(direct);
  return applied.length ? `applied: ${applied.join(", ")}` : "already up to date";
});
await step("connect (pooled)", async () => (await pooled.query("SELECT current_database() AS d")).rows[0].d);
const id = randomUUID();
await step("write test session (pooled)", async () => {
  await pooled.query("INSERT INTO sessions (id, max_call_seconds, status, end_reason) VALUES ($1, 60, 'ended', 'db_check')", [id]);
  return id.slice(0, 8);
});
await step("read it back (pooled)", async () => {
  const r = await pooled.query("SELECT status, end_reason FROM sessions WHERE id = $1", [id]);
  if (r.rows[0]?.end_reason !== "db_check") throw new Error("row not found");
  return `${r.rows[0].status}/${r.rows[0].end_reason}`;
});
await step("delete test session (pooled)", async () => {
  const r = await pooled.query("DELETE FROM sessions WHERE id = $1", [id]);
  return `${r.rowCount} row removed`;
});
await step("tables present", async () => {
  const r = await pooled.query(
    "SELECT string_agg(table_name, ', ' ORDER BY table_name) AS t FROM information_schema.tables WHERE table_schema = 'public'",
  );
  return r.rows[0].t;
});

await direct.end();
await pooled.end();
console.log(failed ? "\nDATABASE CHECK FAILED" : "\nDATABASE CHECK PASSED");
process.exit(failed ? 1 : 0);
