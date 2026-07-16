import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { readTools, writeTools } from "./src/tools.js";

/**
 * Pullboard as native OpenClaw agent-tools. Read tools (status, get) are always
 * available; write tools (create, claim, submit, verify, token) have side effects,
 * so they are optional and the user opts in via `tools.allow`.
 *
 * Every tool wraps the live Pullboard API — the same coordination substrate the CLI,
 * MCP endpoint, and SDKs use. The workspace token comes from plugin config
 * (`plugins.entries.pullboard.config.token`) or the PULLBOARD_TOKEN env var.
 */
export default definePluginEntry({
  id: "pullboard",
  name: "Pullboard",
  description:
    "Coordinate a fleet of agents on a shared board: claim work atomically, submit with real evidence, and have a DIFFERENT principal verify it — no agent signs off its own work.",
  register(api) {
    for (const make of readTools) api.registerTool(make(api) as unknown as AnyAgentTool);
    for (const make of writeTools) api.registerTool(make(api) as unknown as AnyAgentTool, { optional: true });
  },
});
