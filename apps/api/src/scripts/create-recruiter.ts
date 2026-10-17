/**
 * Creates a recruiter login, or resets the password if the email already exists.
 * A strong random password is generated and printed once; it is never stored in plain text.
 *
 *   npm run create-recruiter -- you@example.com "Your Name"
 */
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "../auth.js";
import { createPool, migrate } from "../db.js";

const email = process.argv[2]?.trim().toLowerCase();
const name = process.argv.slice(3).join(" ").trim() || "Recruiter";
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run create-recruiter -- you@example.com "Your Name"');
  process.exit(1);
}
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is missing from .env");
  process.exit(1);
}

const pool = createPool(url, 1);
try {
  await migrate(pool);
  const password = randomBytes(15).toString("base64url");
  const hash = await hashPassword(password);
  const r = await pool.query<{ inserted: boolean }>(
    `INSERT INTO recruiters (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, display_name = EXCLUDED.display_name
     RETURNING (xmax = 0) AS inserted`,
    [randomUUID(), email, name, hash],
  );
  // Log out existing sessions after a password reset.
  if (!r.rows[0]?.inserted) {
    await pool.query("DELETE FROM recruiter_sessions WHERE recruiter_id = (SELECT id FROM recruiters WHERE email = $1)", [email]);
  }
  console.log(`\n${r.rows[0]?.inserted ? "Recruiter created" : "Password reset"} for ${email}.`);
  console.log("\nPassword (shown once, save it in your password manager, do not paste it in chat):\n");
  console.log(`  ${password}\n`);
} finally {
  await pool.end();
}
