import type { Env } from "./types";

export interface MiniMaxJsonOptions {
  system: string;
  user: string;
  maxCompletionTokens?: number;
}

function stripThinkAndFence(value: string): string {
  const withoutThink = value.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return withoutThink
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/i, "")
    .trim();
}

function parseJsonFromText<T>(raw: string): T {
  const cleaned = stripThinkAndFence(raw);
  const candidates = [cleaned];

  const objectStart = cleaned.indexOf("{");
  const objectEnd = cleaned.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(cleaned.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(cleaned.slice(arrayStart, arrayEnd + 1));
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("MiniMax returned invalid JSON");
}

async function completion(env: Env, options: MiniMaxJsonOptions, repair = false): Promise<string> {
  const chatPath = env.MINIMAX_CHAT_PATH || "/text/chatcompletion_v2";
  const base = env.MINIMAX_BASE_URL.replace(/\/$/, "");
  const path = chatPath.startsWith("/") ? chatPath : `/${chatPath}`;

  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.MINIMAX_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: env.MINIMAX_MODEL || "MiniMax-M3",
      messages: [
        {
          role: "system",
          content: [
            options.system,
            repair
              ? "The previous response was not parseable JSON. Return exactly one valid JSON object or array and no surrounding prose."
              : "Return exactly one valid JSON object or array and no markdown fence."
          ].join(" ")
        },
        { role: "user", content: options.user }
      ],
      max_tokens: options.maxCompletionTokens ?? 12000,
      temperature: 0.1
    })
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`MiniMax ${response.status}: ${body.slice(0, 2000)}`);
  }

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`MiniMax returned a non-JSON HTTP payload: ${body.slice(0, 1000)}`);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`MiniMax returned no text content: ${body.slice(0, 1000)}`);
  }
  return content;
}

export async function minimaxJson<T>(env: Env, options: MiniMaxJsonOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await completion(env, options, attempt > 0);
    try {
      return parseJsonFromText<T>(content);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `MiniMax failed to produce valid JSON after repair retry: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

export async function tokenPlanRemains(env: Env): Promise<unknown> {
  const response = await fetch("https://www.minimax.io/v1/token_plan/remains", {
    headers: {
      authorization: `Bearer ${env.MINIMAX_API_KEY}`,
      "content-type": "application/json"
    }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`MiniMax quota ${response.status}: ${body}`);
  try { return JSON.parse(body); } catch { return { raw: body }; }
}
