/** Prints fresh random values for the three local secrets. Paste them into .env. */
import { randomBytes } from "node:crypto";

const make = (bytes: number) => randomBytes(bytes).toString("base64url");

console.log("\nPaste these into your .env file:\n");
console.log(`LLM_PROXY_SECRET=${make(32)}`);
console.log(`WEBHOOK_SECRET=${make(32)}`);
console.log(`POC_ACCESS_TOKEN=${make(18)}\n`);
