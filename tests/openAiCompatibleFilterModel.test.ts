import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  FilterModelResponseError,
  OpenAiCompatibleFilterModel,
} from "../src/adapters/OpenAiCompatibleFilterModel.js";
import { FILTER_GENERATION_SCHEMA } from "../src/metadata/filterSchema.js";
import type { MetadataCatalog } from "../src/types.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const catalog: MetadataCatalog = {
  tenantId: "t",
  generatedAt: "2026-01-01T00:00:00Z",
  keys: [
    {
      ns: "knowmax",
      key: "region",
      registered: true,
      description: "Customer home region",
      declaredType: "string",
      observed: [{ type: "string", articleCount: 3 }],
    },
  ],
};
const ctx = { tenantId: "t", language: "en" };

const chat = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

function mk(overrides = {}) {
  return new OpenAiCompatibleFilterModel({
    baseUrl: "http://x/v1",
    model: "m",
    retryBaseDelayMs: 0,
    ...overrides,
  });
}

describe("OpenAiCompatibleFilterModel", () => {
  it("sends strict json_schema request with briefing", async () => {
    const f = mock(async (_u: string, _i: { body: string }) => chat('{"filter":null}'));
    globalThis.fetch = f as unknown as typeof fetch;
    await mk({ apiKey: "k" }).generateFilter("EU stuff", catalog, ctx);
    const [url, init] = f.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("http://x/v1/chat/completions");
    const body = JSON.parse(init.body);
    expect(body.temperature).toBe(0);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("rag_filter");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema).toEqual(
      JSON.parse(JSON.stringify(FILTER_GENERATION_SCHEMA)),
    );
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("- ns=knowmax key=region type=string");
    expect(body.messages[1]).toEqual({ role: "user", content: "EU stuff" });
  });

  it("returns the filter object", async () => {
    const filter = {
      key: "region",
      op: "equals",
      value: "EU",
      ns: null,
      type: null,
      caseSensitive: null,
    };
    globalThis.fetch = mock(async () =>
      chat(JSON.stringify({ filter })),
    ) as unknown as typeof fetch;
    expect(await mk().generateFilter("q", catalog, ctx)).toEqual(filter);
  });

  it("returns null for no filter", async () => {
    globalThis.fetch = mock(async () => chat('{"filter":null}')) as unknown as typeof fetch;
    expect(await mk().generateFilter("q", catalog, ctx)).toBeNull();
  });

  it("throws FilterModelResponseError without retry on non-JSON content", async () => {
    const f = mock(async () => chat("not json"));
    globalThis.fetch = f as unknown as typeof fetch;
    await expect(mk({ maxRetries: 3 }).generateFilter("q", catalog, ctx)).rejects.toBeInstanceOf(
      FilterModelResponseError,
    );
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("throws on JSON without a filter field", async () => {
    globalThis.fetch = mock(async () => chat('{"x":1}')) as unknown as typeof fetch;
    await expect(mk().generateFilter("q", catalog, ctx)).rejects.toBeInstanceOf(
      FilterModelResponseError,
    );
  });

  it("retries a 503 then succeeds", async () => {
    const f = mock()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(chat('{"filter":null}'));
    globalThis.fetch = f as unknown as typeof fetch;
    expect(await mk().generateFilter("q", catalog, ctx)).toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("fails fast on 400", async () => {
    const f = mock(async () => new Response("bad", { status: 400 }));
    globalThis.fetch = f as unknown as typeof fetch;
    await expect(mk().generateFilter("q", catalog, ctx)).rejects.toThrow("400");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("aborts on timeout and retries per maxRetries", async () => {
    const f = mock(
      (_u: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    );
    globalThis.fetch = f as unknown as typeof fetch;
    await expect(
      mk({ timeoutMs: 10, maxRetries: 1 }).generateFilter("q", catalog, ctx),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f).toHaveBeenCalledTimes(2);
  });
});
