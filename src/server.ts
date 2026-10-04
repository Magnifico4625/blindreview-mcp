#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./create-server.js";

// stdout is the MCP channel: log only to stderr.
async function main(): Promise<void> {
  const envFile = loadDotEnv();
  const config = loadConfig();
  const server = createServer({ config });
  await server.connect(new StdioServerTransport());
  console.error(
    `[blindreview] ${SERVER_NAME} ${SERVER_VERSION} ready on stdio (model=${config.model}, base=${new URL(config.baseUrl).host}, env=${envFile ?? "none"}, telemetry=${config.telemetryEnabled})`,
  );
  if (!config.apiKey) console.error("[blindreview] REVIEWER_API_KEY is not set (fine for local servers that need no key).");
}

main().catch((err: unknown) => {
  console.error(`[blindreview] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
