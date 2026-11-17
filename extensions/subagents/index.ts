import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import herdrSubagents from "./src/herdr.js";
import processSubagents from "./src/index.js";

export { spawnSubagent } from "./src/spawner.js";
export type { SpawnSubagentOptions, SpawnSubagentResult } from "./src/spawner.js";

/** Inside herdr (hc sets HC_TERMINAL_ID) subagents are interactive herdr terminals; elsewhere, headless child processes. */
export default function (pi: ExtensionAPI) {
  return process.env.HC_TERMINAL_ID ? herdrSubagents(pi) : processSubagents(pi);
}
