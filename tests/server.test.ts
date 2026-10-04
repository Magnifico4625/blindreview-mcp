import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { findProjectRoot } from "../src/config.js";
import { createServer } from "../src/create-server.js";
import { ReviewResultSchema } from "../src/schemas/review.js";
import { FakeProvider, SENTINEL, allText, makeInput, testConfig, validPosition, validVerdict } from "./helpers.js";

async function connect(provider: FakeProvider) {
  const server = createServer({ config: testConfig, provider });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe("MCP server (in-memory)", () => {
  it("lists review_decision, should_review and record_outcome", async () => {
    const client = await connect(FakeProvider.sequence(validVerdict));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["record_outcome", "review_decision", "should_review"]);
    const review = tools.find((t) => t.name === "review_decision")!;
    expect(review.inputSchema.required).toEqual(
      expect.arrayContaining(["objective", "constraints", "context", "proposed_solution", "decision_type", "risk_level"]),
    );
    expect(review.outputSchema).toBeDefined();
  });

  it("runs a blind-first review end to end and returns structured content", async () => {
    const provider = FakeProvider.sequence(validPosition, validVerdict);
    const client = await connect(provider);
    const res = await client.callTool({ name: "review_decision", arguments: makeInput() });
    expect(res.isError).toBeFalsy();
    const parsed = ReviewResultSchema.parse(res.structuredContent);
    expect(parsed.verdict).toBe("MODIFY");
    expect(allText(provider.requests[0]!)).not.toContain(SENTINEL);
  });

  it("returns typed isError results for provider failures and bad input", async () => {
    const client = await connect(FakeProvider.sequence("garbage", "garbage"));
    const res = await client.callTool({ name: "review_decision", arguments: makeInput() });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ error: { code: "MALFORMED_RESPONSE" } });

    const bad = await client.callTool({ name: "review_decision", arguments: { objective: "x" } });
    expect(bad.isError).toBe(true);
  });

  it("exposes the deterministic gate", async () => {
    const client = await connect(FakeProvider.sequence(validVerdict));
    const res = await client.callTool({ name: "should_review", arguments: { decision_type: "database", risk_level: "high", includes_migration: true } });
    expect(res.structuredContent).toMatchObject({ should_review: true });
  });

  it("record_outcome is a no-op when telemetry is disabled", async () => {
    const client = await connect(FakeProvider.sequence(validVerdict));
    const res = await client.callTool({ name: "record_outcome", arguments: { review_id: "x", accepted_review: true } });
    expect(res.structuredContent).toMatchObject({ recorded: false });
  });
});

describe("MCP server (built, over stdio)", () => {
  it("starts with node and lists review_decision", async () => {
    const entry = path.join(findProjectRoot(), "dist", "src", "server.js");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...(process.env as Record<string, string>), BLINDREVIEW_ENV_FILE: path.join(findProjectRoot(), "does-not-exist.env"), REVIEWER_API_KEY: "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("review_decision");
    } finally {
      await client.close();
    }
  });
});
