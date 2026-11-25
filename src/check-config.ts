import "dotenv/config";
import { loadConfig } from "./config.js";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Configuration invalid: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

console.log(
  `Configuration valid: ${config.rooms.length} room(s), ` +
    `primary model ${config.openaiModel}, ` +
    `fallback ${config.fallback ? "enabled" : "disabled"}`
);
