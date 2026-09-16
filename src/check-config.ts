import "dotenv/config";
import { loadConfig } from "./config.js";

const config = loadConfig();

console.log(
  `Configuration valid: ${config.rooms.length} room(s), ` +
    `primary model ${config.openaiModel}, ` +
    `fallback ${config.fallback ? "enabled" : "disabled"}`
);
