import type { Env } from "./types";

export interface MiniMaxJsonOptions {
  system: string;
  user: string;
  maxCompletionTokens?: number;
}

const GLOBAL_CHAT = "https://api.minimax.io/v1/text/chatcompletion_v2";
const CN_CHAT = "https://api.minimaxi.com/v1/text/chatcompletion_v2";
const GLOBAL_QUOTA = "https://www.minimax.io/v1/token_plan/remains";
const CN_QUOTA = "https://www.minimaxi.com/v1/token_plan/remains";

function orderedEndpoints(preferred: string | undefined, globalUrl: string, cnUrl: string): string[] {
  const first = preferred || globalUrl;
  const fallback = first.includes("minimaxi.com") ? globalUrl : cnUrl;
  return Array.from(new Set([first, fallback]));
}

function stripThinkAndFence(value: string): string {
  const withoutThink = value.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return withoutThink.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function parseMaybeJson(raw: string): any {
  try { return JSON.parse(raw); } catch { return null; }
}

function statusMessage(payload: any, raw: string): string {
  return String(
    payload?.base_resp?.status_msg ??
    payload?.error?.message ??
    payload?.message ??
    raw
  );
}

function invalidApiKey(response: Response, payload: any, raw: string): boolean {
  const message = statusMessage(payload, raw).toLowerCase();
  return response.status === 401 ||
    response.status === 403 ||
    message.includes("invalid api key") ||
    message.includes("invalid_api_key");
}

function assertProviderSuccess(response: Response, payload: any, raw: string): void {
  const code = payload?.base_resp?.status_code;
  if (!response.ok || (typeof code === "number" && code !== 0)) {
    throw new Error(`MiniMax ${response.status}: ${statusMessage(payload, raw).slice(0, 1000)}`);
  }
}

export async function minimaxJson<T>(env: Env, options: MiniMaxJsonOptions): Promise<T> {
  const endpoints = orderedEndpoints(env.MINIMAX_CHAT_URL, GLOBAL_CHAT, CN_CHAT);
  let lastError = "MiniMax request failed";

  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, {
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
        max_completion_tokens: options.maxCompletionTokens ?? 12000,
        temperature: 0.2
      })
    });

    const raw = await response.text();
    const payload = parseMaybeJson(raw);

    if (invalidApiKey(response, payload, raw)) {
      lastError = `MiniMax key rejected by ${new URL(endpoint).hostname}`;
      continue;
    }

    assertProviderSuccess(response, payload, raw);

    const text =
      payload?.choices?.[0]?.message?.content ??
      payload?.reply ??
      payload?.choices?.[0]?.text;

    if (typeof text !== "string") {
      throw new Error(`MiniMax returned no text content: ${raw.slice(0, 1000)}`);
    }

    try {
      return JSON.parse(stripThinkAndFence(text)) as T;
    } catch (error) {
      throw new Error(
        `MiniMax returned non-JSON content: ${stripThinkAndFence(text).slice(0, 1200)}`
      );
    }
  }

  throw new Error(
    `${lastError}; the configured Token Plan key was rejected by both minimax.io and minimaxi.com`
  );
}

export async function tokenPlanRemains(env: Env): Promise<unknown> {
  const preferredQuota = env.MINIMAX_CHAT_URL?.includes("minimaxi.com") ? CN_QUOTA : GLOBAL_QUOTA;
  const endpoints = orderedEndpoints(preferredQuota, GLOBAL_QUOTA, CN_QUOTA);
  let lastError = "MiniMax quota request failed";

  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${env.MINIMAX_API_KEY}`,
        "content-type": "application/json"
      }
    });
    const raw = await response.text();
    const payload = parseMaybeJson(raw);

    if (invalidApiKey(response, payload, raw)) {
      lastError = `MiniMax key rejected by ${new URL(endpoint).hostname}`;
      continue;
    }
    assertProviderSuccess(response, payload, raw);
    return payload ?? { raw };
  }

  throw new Error(
    `${lastError}; the configured Token Plan key was rejected by both minimax.io and minimaxi.com`
  );
}
