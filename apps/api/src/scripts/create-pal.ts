/**
 * Creates the Tavus PAL that points at our custom LLM endpoint.
 * Run again whenever PUBLIC_BASE_URL changes (for example a new tunnel URL),
 * then put the printed pal_id into TAVUS_PAL_ID in .env.
 */
import { loadConfig, tavusAuth } from "../config.js";
import { createPal, TavusError } from "../tavus.js";

const config = loadConfig();
if (!config.TAVUS_FACE_ID) {
  console.error("\nTAVUS_FACE_ID is empty in .env. Copy a stock face ID from the Tavus dashboard first.\n");
  process.exit(1);
}
const llmBaseUrl = `${config.PUBLIC_BASE_URL}/llm/v1`;

try {
  const pal = await createPal(tavusAuth(config), {
    palName: `iNTERVIEWER PoC ${new Date().toISOString().slice(0, 16)}`,
    faceId: config.TAVUS_FACE_ID,
    llmBaseUrl,
    llmApiKey: config.LLM_PROXY_SECRET,
  });
  console.log("\nPAL created.");
  console.log(`  custom LLM base_url: ${llmBaseUrl}`);
  console.log("  perception: off");
  console.log(`\nAdd this line to your .env file:\n\nTAVUS_PAL_ID=${pal.pal_id}\n`);
} catch (err) {
  if (err instanceof TavusError) {
    console.error(`\n${err.message}\n${err.body}\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
}
