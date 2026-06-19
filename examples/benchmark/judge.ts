import type { RagResult } from "../../src/index.js";

export interface JudgeConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Read JUDGE_* env; undefined if not fully configured. */
export function judgeEnabledFromEnv(): JudgeConfig | undefined {
  const baseUrl = process.env.JUDGE_BASE_URL;
  const model = process.env.JUDGE_MODEL;
  if (!baseUrl || !model) return undefined;
  return { baseUrl, model, apiKey: process.env.JUDGE_API_KEY };
}

/** Extract the first `n` integer 0/1/2 ratings from a model reply; pad/truncate to n; default 0. */
export function parseJudgeScores(raw: string, n: number): number[] {
  const nums = (raw.match(/[012]/g) ?? []).map(Number).slice(0, n);
  while (nums.length < n) nums.push(0);
  return nums;
}

/** Ask the chat model to rate each result 0/1/2 for relevance to the query. */
export async function judgeResults(
  query: string,
  results: RagResult[],
  cfg: JudgeConfig,
): Promise<number[]> {
  if (results.length === 0) return [];
  const blocks = results
    .map((r, i) => `[${i + 1}] ${r.content.slice(0, 500).replace(/\n/g, " ")}`)
    .join("\n");
  const prompt =
    `سؤال المستخدم: "${query}"\n` +
    `قيّم مدى صلة كل مقطع بالسؤال على مقياس 0 (غير ذي صلة)، 1 (ذو صلة جزئية)، 2 (يجيب على السؤال).\n` +
    `أعد الأرقام فقط بالترتيب ومفصولة بفواصل.\n${blocks}`;
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Judge error ${res.status}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return parseJudgeScores(data.choices[0]?.message?.content ?? "", results.length);
}
