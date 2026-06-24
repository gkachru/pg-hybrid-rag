import { afterEach, describe, expect, test } from "bun:test";
import { HttpThaiSegmenter } from "../nestjs-thai-segmenter";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function setFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(url), init ?? {}))) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HttpThaiSegmenter", () => {
  test("passthrough: non-Thai language returns unchanged, no HTTP call", async () => {
    let called = false;
    setFetch(() => {
      called = true;
      return json({ segmented: [""] });
    });
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x" });
    expect(await seg.segment("hello world", "en")).toBe("hello world");
    expect(called).toBe(false);
  });

  test("passthrough: blank text returns unchanged", async () => {
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x" });
    expect(await seg.segment("   ", "th")).toBe("   ");
  });

  test("segments Thai via POST /segment and returns space-joined tokens", async () => {
    setFetch((url, init) => {
      expect(url).toBe("http://x/segment");
      const body = JSON.parse(init.body as string) as { texts: string[] };
      expect(body.texts).toEqual(["นโยบายการคืนสินค้า"]);
      return json({ segmented: ["นโยบาย การ คืน สินค้า"] });
    });
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x" });
    expect(await seg.segment("นโยบายการคืนสินค้า", "th")).toBe("นโยบาย การ คืน สินค้า");
  });

  test("segmentsLanguage matches base subtag", () => {
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x" });
    expect(seg.segmentsLanguage("th")).toBe(true);
    expect(seg.segmentsLanguage("th-TH")).toBe(true);
    expect(seg.segmentsLanguage("en")).toBe(false);
  });

  test("contract guard: throws if non-whitespace content changes", async () => {
    setFetch(() => json({ segmented: ["นโยบาย ___ สินค้า"] }));
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x" });
    await expect(seg.segment("นโยบายสินค้า", "th")).rejects.toThrow(/contract/i);
  });

  test("retries on 5xx, then succeeds", async () => {
    let calls = 0;
    setFetch(() => {
      calls += 1;
      return calls === 1 ? json({ error: "boom" }, 503) : json({ segmented: ["ก ข"] });
    });
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x", retryBaseDelayMs: 1 });
    expect(await seg.segment("กข", "th")).toBe("ก ข");
    expect(calls).toBe(2);
  });

  test("throws immediately on non-retryable 4xx (no retry)", async () => {
    let calls = 0;
    setFetch(() => {
      calls += 1;
      return json({ error: "bad" }, 400);
    });
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x", maxRetries: 3 });
    await expect(seg.segment("กข", "th")).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  test("throws on malformed response shape (no retry)", async () => {
    let calls = 0;
    setFetch(() => {
      calls += 1;
      return json({ segmented: "not-an-array" });
    });
    const seg = new HttpThaiSegmenter({ baseUrl: "http://x", maxRetries: 3 });
    await expect(seg.segment("กข", "th")).rejects.toThrow(/malformed/i);
    expect(calls).toBe(1);
  });
});
