import type { FilterModelContext, FilterModelProvider } from "../interfaces.js";
import { renderCatalogBriefing } from "../metadata/briefing.js";
import { FILTER_GENERATION_SCHEMA } from "../metadata/filterSchema.js";
import type { MetadataCatalog } from "../types.js";

export interface OpenAiCompatibleFilterModelConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Per-request timeout in ms (default: 10000). Set 0 to disable. */
  timeoutMs?: number;
  /** Max retry attempts after the first try, on 429/5xx/network/timeout errors (default: 1). */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff between retries (default: 250). */
  retryBaseDelayMs?: number;
  /** Optional `max_tokens` for the completion. Omitted from the request when unset. */
  maxTokens?: number;
  /** Limits on how much of the catalog is rendered into the prompt. */
  briefing?: { maxKeys?: number; maxValuesPerKey?: number };
  /** Replaces the default system prompt (the catalog briefing is still appended). */
  systemPrompt?: string;
}

/** Error carrying the HTTP status of a non-OK filter model response. */
export class FilterModelApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Filter model API error ${status}: ${body}`);
    this.name = "FilterModelApiError";
  }
}

/** A 200 response whose body is not the expected `{ filter }` JSON. Non-retryable. */
export class FilterModelResponseError extends Error {
  constructor(message: string) {
    super(`Filter model response error: ${message}`);
    this.name = "FilterModelResponseError";
  }
}

export const DEFAULT_FILTER_SYSTEM_PROMPT = [
  "You convert a user's search query into a metadata filter.",
  "Output only keys that appear in the briefing below; never invent keys or values.",
  "Set `ns` only when the query implies a source; otherwise leave it null.",
  "Set `type` when the value is a date, datetime or decimal.",
  'Return {"filter": null} when the query implies no filter.',
].join("\n");

function isRetryableError(err: unknown): boolean {
  if (err instanceof FilterModelApiError) return err.status === 429 || err.status >= 500;
  if (err instanceof FilterModelResponseError) return false;
  const name = (err as { name?: string } | null | undefined)?.name;
  return name === "AbortError" || name === "TypeError";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch-based filter model for OpenAI-compatible chat completion APIs with strict JSON schema output. */
export class OpenAiCompatibleFilterModel implements FilterModelProvider {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(private readonly config: OpenAiCompatibleFilterModelConfig) {
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxRetries = config.maxRetries ?? 1;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 250;
    if (
      config.maxTokens !== undefined &&
      (!Number.isInteger(config.maxTokens) || config.maxTokens <= 0)
    ) {
      throw new Error("OpenAiCompatibleFilterModel: maxTokens must be a positive integer");
    }
  }

  async generateFilter(
    query: string,
    catalog: MetadataCatalog,
    ctx: FilterModelContext,
  ): Promise<unknown> {
    const system = `${this.config.systemPrompt ?? DEFAULT_FILTER_SYSTEM_PROMPT}\n\nAvailable keys:\n${renderCatalogBriefing(catalog, this.config.briefing)}`;
    const body = JSON.stringify({
      model: this.config.model,
      temperature: 0,
      ...(this.config.maxTokens !== undefined ? { max_tokens: this.config.maxTokens } : {}),
      response_format: {
        type: "json_schema",
        json_schema: { name: "rag_filter", strict: true, schema: FILTER_GENERATION_SCHEMA },
      },
      messages: [
        { role: "system", content: system },
        { role: "user", content: query },
      ],
    });
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request(body, ctx.signal);
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        if (attempt >= this.maxRetries || !isRetryableError(err)) throw err;
        await delay(this.retryBaseDelayMs * 2 ** attempt);
        // The caller may abort during the backoff; don't start another request after that.
        if (ctx.signal?.aborted) throw err;
      }
    }
  }

  private async request(body: string, callerSignal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer =
      this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
      const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new FilterModelApiError(res.status, await res.text().catch(() => ""));
      }
      return this.parse(await res.json());
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private parse(payload: unknown): unknown {
    const content = (
      payload as { choices?: Array<{ message?: { content?: unknown } }> } | null | undefined
    )?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new FilterModelResponseError("response is missing `choices[0].message.content`");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new FilterModelResponseError("message content is not valid JSON");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("filter" in parsed)
    ) {
      throw new FilterModelResponseError("message content has no `filter` field");
    }
    return (parsed as { filter: unknown }).filter;
  }
}
