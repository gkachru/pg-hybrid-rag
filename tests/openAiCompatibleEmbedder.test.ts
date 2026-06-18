import { afterEach, describe, expect, it, mock } from "bun:test";
import { OpenAiCompatibleEmbedder } from "../src/adapters/OpenAiCompatibleEmbedder.js";
import { EmbeddingApiError, EmbeddingResponseError } from "../src/index.js";

const realFetch = globalThis.fetch;

/** Last request body the mock fetch received (parsed). */
let lastBody: { input: string[]; model: string };

/**
 * Install a mock `fetch` that encodes each input's last character code as its
 * embedding ([charCode]) and returns `data` in the order produced by `respond`.
 * `withIndex` controls whether each result carries an OpenAI-style `index` field.
 */
function installFetch(opts: { withIndex: boolean; respond: <T>(items: T[]) => T[] }) {
  globalThis.fetch = mock(async (_url: string, init: { body: string }) => {
    lastBody = JSON.parse(init.body);
    const data = lastBody.input.map((text, i) => ({
      ...(opts.withIndex ? { index: i } : {}),
      embedding: [text.charCodeAt(text.length - 1)],
    }));
    return new Response(JSON.stringify({ data: opts.respond(data) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function makeEmbedder(overrides: Partial<{ batchSize: number; concurrency: number }> = {}) {
  return new OpenAiCompatibleEmbedder({
    baseUrl: "http://embeddings.test/v1",
    apiKey: "test-key",
    model: "test-model",
    ...overrides,
  });
}

describe("OpenAiCompatibleEmbedder", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns embeddings in input order even when the API responds out of order", async () => {
    // API returns the data array REVERSED, each tagged with its true input index.
    installFetch({ withIndex: true, respond: (items) => [...items].reverse() });
    const embedder = makeEmbedder();

    const result = await embedder.embedDocuments(["a", "b", "c"]);

    // 'a'=97, 'b'=98, 'c'=99 — must come back aligned to input order despite reversal.
    expect(result).toEqual([[97], [98], [99]]);
  });

  it("preserves input order across multiple batches when responses are out of order", async () => {
    // batchSize 2 over 5 inputs → batches [a,b] [c,d] [e]; each responds reversed.
    installFetch({ withIndex: true, respond: (items) => [...items].reverse() });
    const embedder = makeEmbedder({ batchSize: 2 });

    const result = await embedder.embedDocuments(["a", "b", "c", "d", "e"]);

    expect(result).toEqual([[97], [98], [99], [100], [101]]);
  });

  it("falls back to response order when the API omits the index field", async () => {
    // No `index` present; nothing to sort by — preserve the response order as-is.
    installFetch({ withIndex: false, respond: (items) => [...items].reverse() });
    const embedder = makeEmbedder();

    const result = await embedder.embedDocuments(["a", "b", "c"]);

    expect(result).toEqual([[99], [98], [97]]);
  });

  it("applies the query prefix and returns a single vector for embedQuery", async () => {
    installFetch({ withIndex: true, respond: (items) => items });
    const embedder = makeEmbedder();

    const vec = await embedder.embedQuery("hello");

    expect(lastBody.input).toEqual(["query: hello"]);
    expect(vec).toEqual(["hello".charCodeAt(4)]); // last char 'o'
  });
});

describe("OpenAiCompatibleEmbedder payload validation", () => {
  let calls: number;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Install a mock fetch that returns a 200 response with the given JSON body. */
  function installBody(body: unknown) {
    calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  function newEmbedder() {
    return new OpenAiCompatibleEmbedder({
      baseUrl: "http://embeddings.test/v1",
      apiKey: "test-key",
      model: "test-model",
      retryBaseDelayMs: 0,
      maxRetries: 2,
    });
  }

  it("throws a descriptive error when the response has no data array", async () => {
    installBody({ error: { message: "bad request" } });
    await expect(newEmbedder().embedQuery("hi")).rejects.toThrow(/data/i);
  });

  it("does not retry an invalid payload shape", async () => {
    // A misconfigured endpoint returning the wrong shape must fail fast, not retry.
    installBody({ error: { message: "bad request" } });
    await expect(newEmbedder().embedQuery("hi")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("throws when data is present but not an array", async () => {
    installBody({ data: { embedding: [1] } });
    await expect(newEmbedder().embedQuery("hi")).rejects.toThrow(/data/i);
  });

  it("throws when the returned embedding count does not match the input count", async () => {
    // Two inputs requested, but only one embedding returned.
    installBody({ data: [{ index: 0, embedding: [1] }] });
    await expect(newEmbedder().embedDocuments(["a", "b"])).rejects.toThrow(
      /count|length|expected/i,
    );
  });

  it("throws when an entry is missing its embedding array", async () => {
    installBody({ data: [{ index: 0 }] });
    await expect(newEmbedder().embedQuery("hi")).rejects.toThrow();
  });

  it("rejects duplicate index values instead of silently misaligning", async () => {
    installBody({
      data: [
        { index: 0, embedding: [1] },
        { index: 0, embedding: [2] },
      ],
    });
    await expect(newEmbedder().embedDocuments(["a", "b"])).rejects.toBeInstanceOf(
      EmbeddingResponseError,
    );
  });

  it("rejects sparse (out-of-range) index values", async () => {
    installBody({
      data: [
        { index: 0, embedding: [1] },
        { index: 2, embedding: [2] },
      ],
    });
    await expect(newEmbedder().embedDocuments(["a", "b"])).rejects.toBeInstanceOf(
      EmbeddingResponseError,
    );
  });

  it("rejects a response that mixes indexed and non-indexed entries", async () => {
    installBody({ data: [{ index: 0, embedding: [1] }, { embedding: [2] }] });
    await expect(newEmbedder().embedDocuments(["a", "b"])).rejects.toBeInstanceOf(
      EmbeddingResponseError,
    );
  });

  it("rejects embedding arrays whose elements are not finite numbers", async () => {
    installBody({ data: [{ index: 0, embedding: ["a", "b"] }] });
    await expect(newEmbedder().embedQuery("hi")).rejects.toBeInstanceOf(EmbeddingResponseError);
  });
});

describe("OpenAiCompatibleEmbedder timeout and retry", () => {
  let calls: number;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Per-call behavior: an HTTP status number, "network" (throw), or "hang" (resolve only on abort). */
  type Behavior = number | "network" | "hang";

  /** Install a mock fetch that walks `behaviors`, reusing the last entry once exhausted. */
  function installSequence(behaviors: Behavior[]) {
    calls = 0;
    globalThis.fetch = mock(async (_url: string, init: { body: string; signal?: AbortSignal }) => {
      const behavior = behaviors[Math.min(calls, behaviors.length - 1)];
      calls++;
      if (behavior === "network") throw new TypeError("network failure");
      if (behavior === "hang") {
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      if (behavior !== 200) {
        return new Response(`error ${behavior}`, { status: behavior });
      }
      const body = JSON.parse(init.body) as { input: string[] };
      const data = body.input.map((t, i) => ({
        index: i,
        embedding: [t.charCodeAt(t.length - 1)],
      }));
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  function newEmbedder(
    overrides: Partial<{ timeoutMs: number; maxRetries: number; retryBaseDelayMs: number }> = {},
  ) {
    return new OpenAiCompatibleEmbedder({
      baseUrl: "http://embeddings.test/v1",
      apiKey: "test-key",
      model: "test-model",
      retryBaseDelayMs: 0,
      ...overrides,
    });
  }

  it("retries a 5xx response and succeeds", async () => {
    installSequence([503, 200]);
    const vec = await newEmbedder({ maxRetries: 2 }).embedQuery("hi");
    expect(vec).toEqual(["hi".charCodeAt(1)]); // 'i'
    expect(calls).toBe(2);
  });

  it("retries a 429 response and succeeds", async () => {
    installSequence([429, 200]);
    const vec = await newEmbedder({ maxRetries: 2 }).embedQuery("hi");
    expect(vec).toEqual(["hi".charCodeAt(1)]);
    expect(calls).toBe(2);
  });

  it("retries a network error and succeeds", async () => {
    installSequence(["network", 200]);
    const vec = await newEmbedder({ maxRetries: 2 }).embedQuery("hi");
    expect(vec).toEqual(["hi".charCodeAt(1)]);
    expect(calls).toBe(2);
  });

  it("gives up after maxRetries on a persistent 5xx", async () => {
    installSequence([503]);
    await expect(newEmbedder({ maxRetries: 2 }).embedQuery("hi")).rejects.toThrow();
    expect(calls).toBe(3); // 1 initial attempt + 2 retries
  });

  it("does not retry a 4xx response", async () => {
    installSequence([400, 200]);
    await expect(newEmbedder({ maxRetries: 2 }).embedQuery("hi")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("throws an exported EmbeddingApiError carrying the HTTP status on a non-OK response", async () => {
    installSequence([401]);
    const err = await newEmbedder({ maxRetries: 0 })
      .embedQuery("hi")
      .catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingApiError);
    expect((err as EmbeddingApiError).status).toBe(401);
  });

  it("aborts a request that exceeds the timeout", async () => {
    installSequence(["hang"]);
    await expect(newEmbedder({ timeoutMs: 10, maxRetries: 0 }).embedQuery("hi")).rejects.toThrow();
  });
});

describe("OpenAiCompatibleEmbedder config validation", () => {
  it("throws on a non-positive batchSize", () => {
    // batchSize 0 makes the embedDocuments batching loop (i += batchSize) spin forever.
    expect(() => makeEmbedder({ batchSize: 0 })).toThrow(/batchSize/);
    expect(() => makeEmbedder({ batchSize: -1 })).toThrow(/batchSize/);
  });

  it("throws on a non-positive concurrency", () => {
    // concurrency 0 makes the outer batch loop (i += concurrency) spin forever.
    expect(() => makeEmbedder({ concurrency: 0 })).toThrow(/concurrency/);
    expect(() => makeEmbedder({ concurrency: -1 })).toThrow(/concurrency/);
  });
});
