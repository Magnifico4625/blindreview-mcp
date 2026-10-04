import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { ReviewError } from "../src/schemas/review.js";

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function mockFetch(handler: (call: Call, i: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: init?.headers as Record<string, string>,
    };
    calls.push(call);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { impl, calls };
}

const ok = (content: unknown, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      model: "served-model",
      choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      ...extra,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const req = () => ({ messages: [{ role: "user" as const, content: "hi" }], maxTokens: 500, signal: new AbortController().signal });

function provider(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) {
  return new OpenAICompatibleProvider({ baseUrl: "https://api.example.com/v1/", apiKey: "sk-test", model: "m", fetchImpl, ...extra });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "none";
  } catch (e) {
    expect(e).toBeInstanceOf(ReviewError);
    return (e as ReviewError).code;
  }
}

describe("OpenAICompatibleProvider", () => {
  it("posts a chat/completions request with JSON mode and no tools", async () => {
    const { impl, calls } = mockFetch(() => ok({ a: 1 }));
    const res = await provider(impl).complete(req());
    expect(calls[0]!.url).toBe("https://api.example.com/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(calls[0]!.body).toMatchObject({ model: "m", max_tokens: 500, response_format: { type: "json_object" } });
    expect(calls[0]!.body).not.toHaveProperty("tools");
    expect(calls[0]!.body).not.toHaveProperty("reasoning_effort");
    expect(res).toMatchObject({ content: '{"a":1}', model: "served-model", usage: { total_tokens: 15 }, toolCallCount: 0 });
  });

  it("omits the Authorization header when no key is configured (local servers)", async () => {
    const { impl, calls } = mockFetch(() => ok({}));
    await provider(impl, { apiKey: undefined }).complete(req());
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("sends reasoning_effort and retries without it when rejected", async () => {
    const { impl, calls } = mockFetch((_c, i) =>
      i === 0 ? new Response('{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}', { status: 400 }) : ok({}),
    );
    const p = provider(impl, { reasoningEffort: "low" });
    await p.complete(req());
    expect(calls[0]!.body.reasoning_effort).toBe("low");
    expect(calls[1]!.body).not.toHaveProperty("reasoning_effort");
    expect(p.state.reasoningEffort).toBeUndefined();
    await p.complete(req());
    expect(calls).toHaveLength(3); // remembered: no extra retry
  });

  it("uses OpenRouter-style reasoning object for openrouter.ai", async () => {
    const { impl, calls } = mockFetch(() => ok({}));
    await provider(impl, { baseUrl: "https://openrouter.ai/api/v1", reasoningEffort: "medium" }).complete(req());
    expect(calls[0]!.body.reasoning).toEqual({ effort: "medium", exclude: true });
    expect(calls[0]!.body).not.toHaveProperty("reasoning_effort");
  });

  it("switches to max_completion_tokens and drops response_format when rejected", async () => {
    const { impl, calls } = mockFetch((_c, i) => {
      if (i === 0) return new Response("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.", { status: 400 });
      if (i === 1) return new Response("response_format is not supported", { status: 400 });
      return ok({});
    });
    await provider(impl).complete(req());
    expect(calls[2]!.body.max_completion_tokens).toBe(500);
    expect(calls[2]!.body).not.toHaveProperty("max_tokens");
    expect(calls[2]!.body).not.toHaveProperty("response_format");
  });

  it("sends temperature when configured and drops it if rejected", async () => {
    const { impl, calls } = mockFetch((_c, i) =>
      i === 0 ? new Response("Unsupported value: 'temperature' does not support 0.2 with this model", { status: 400 }) : ok({}),
    );
    await provider(impl, { temperature: 0.2 }).complete(req());
    expect(calls[0]!.body.temperature).toBe(0.2);
    expect(calls[1]!.body).not.toHaveProperty("temperature");
  });

  it("reports finish_reason", async () => {
    const { impl } = mockFetch(
      () => new Response(JSON.stringify({ choices: [{ message: { content: "{" }, finish_reason: "length" }] }), { status: 200 }),
    );
    expect((await provider(impl).complete(req())).finishReason).toBe("length");
  });

  it("does not loop forever on persistent 400s", async () => {
    const { impl, calls } = mockFetch(() => new Response("bad request: reasoning max_completion_tokens response_format", { status: 400 }));
    expect(await codeOf(provider(impl, { reasoningEffort: "high" }).complete(req()))).toBe("PROVIDER_HTTP_ERROR");
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  it.each([401, 404, 429, 500, 503])("maps HTTP %i to PROVIDER_HTTP_ERROR with status", async (status) => {
    const { impl } = mockFetch(() => new Response("upstream failure", { status }));
    try {
      await provider(impl).complete(req());
      expect.unreachable();
    } catch (e) {
      expect((e as ReviewError).code).toBe("PROVIDER_HTTP_ERROR");
      expect((e as ReviewError).status).toBe(status);
      expect((e as ReviewError).message).not.toContain("sk-test");
    }
  });

  it("maps network failures to PROVIDER_NETWORK_ERROR", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await codeOf(provider(impl).complete(req()))).toBe("PROVIDER_NETWORK_ERROR");
  });

  it("maps abort to TIMEOUT", async () => {
    const { impl } = mockFetch(() => ok({}));
    const c = new AbortController();
    c.abort();
    expect(await codeOf(provider(impl).complete({ ...req(), signal: c.signal }))).toBe("TIMEOUT");
  });

  it("handles malformed bodies", async () => {
    expect(await codeOf(provider(mockFetch(() => new Response("<html>oops</html>", { status: 200 })).impl).complete(req()))).toBe("MALFORMED_RESPONSE");
    expect(await codeOf(provider(mockFetch(() => new Response("{}", { status: 200 })).impl).complete(req()))).toBe("MALFORMED_RESPONSE");
    expect(
      await codeOf(provider(mockFetch(() => new Response('{"error":{"message":"upstream down","code":502}}', { status: 200 })).impl).complete(req())),
    ).toBe("PROVIDER_HTTP_ERROR");
  });

  it("counts tool calls and estimates missing usage", async () => {
    const { impl } = mockFetch(
      () => new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "1" }, { id: "2" }] } }] }), { status: 200 }),
    );
    const res = await provider(impl).complete(req());
    expect(res.toolCallCount).toBe(2);
    expect(res.content).toBe("");
    expect(res.usage.total_tokens).toBeGreaterThan(0);
    expect(res.model).toBe("m");
  });
});
