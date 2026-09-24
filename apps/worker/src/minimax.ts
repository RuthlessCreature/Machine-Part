import type { Env } from "./types";

export interface MiniMaxJsonOptions {
  system: string;
  user: string;
  maxCompletionTokens?: number;
}

function stripThinkAndFence(value: string): string {
  const withoutThink = value.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return withoutThink.replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/i, "").trim();
}

export async function minimaxJson<T>(env: Env, options: MiniMaxJsonOptions): Promise<T> {
  const response = await fetch(`${env.MINIMAX_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.MINIMAX_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: env.MINIMAX_MODEL || "MiniMax-M3",
      messages: [
        { role: "system", content: options.system },
        { role: "user", content: options.user }
      ],
      thinking: { type: "disabled" },
      reasoning_split: true,
      max_completion_tokens: options.maxCompletionTokens ?? 12000,
      temperature: 0.2
    })
  });
  if (!response.ok) {
    throw new Error(`MiniMax ${response.status}: ${await response.text()}`);
  }
  const payload: any = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("MiniMax returned no text content");
  return JSON.parse(stripThinkAndFence(content)) as T;
}

export async function tokenPlanRemains(env: Env): Promise<unknown> {
  const response = await fetch("https://www.minimax.io/v1/token_plan/remains", {
    headers: { authorization: `Bearer ${env.MINIMAX_API_KEY}` }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`MiniMax quota ${response.status}: ${body}`);
  try { return JSON.parse(body); } catch { return { raw: body }; }
}
