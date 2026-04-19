import "dotenv/config";
import Groq from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const MAX_RETRIES = 3;

const groq = process.env.GROQ_API_KEY ? new Groq() : null;
const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("429") ||
    message.includes("rate_limit") ||
    message.includes("Rate limit") ||
    message.includes("quota") ||
    message.includes("RESOURCE_EXHAUSTED")
  );
}

function parseRetryMs(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  const tpd = message.match(/try again in (\d+)m([\d.]+)s/i);
  if (tpd?.[1] !== undefined && tpd[2] !== undefined) {
    const minutes = parseInt(tpd[1], 10);
    const seconds = parseFloat(tpd[2]);
    return (minutes * 60 + seconds) * 1000;
  }
  const tpm = message.match(/try again in ([\d.]+)(ms|s)/i);
  if (tpm?.[1] !== undefined && tpm[2] !== undefined) {
    const val = parseFloat(tpm[1]);
    return tpm[2].toLowerCase() === "s" ? val * 1000 : val;
  }
  return 0;
}

async function callGroq(
  systemPrompt: string,
  userMessage: string,
  options: { maxTokens?: number; temperature?: number; jsonMode?: boolean } = {}
): Promise<string> {
  if (!groq) throw new Error("GROQ_API_KEY not configured");

  const systemContent = options.jsonMode
    ? `${systemPrompt}\n\nYou MUST respond with valid JSON only. No explanation, no markdown code blocks, no prose.`
    : systemPrompt;

  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userMessage },
    ],
    temperature: options.temperature ?? 0.1,
    max_tokens: options.maxTokens ?? 2048,
    ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Groq returned empty response");
  return content;
}

async function callGemini(
  systemPrompt: string,
  userMessage: string,
  options: { maxTokens?: number; temperature?: number; jsonMode?: boolean } = {}
): Promise<string> {
  if (!gemini) throw new Error("GEMINI_API_KEY not configured");

  const model = gemini.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: options.jsonMode
      ? `${systemPrompt}\n\nYou MUST respond with valid JSON only. No explanation, no markdown code blocks, no prose.`
      : systemPrompt,
    generationConfig: {
      temperature: options.temperature ?? 0.1,
      maxOutputTokens: options.maxTokens ?? 2048,
      ...(options.jsonMode ? { responseMimeType: "application/json" } : {}),
    },
  });

  const result = await model.generateContent(userMessage);
  const content = result.response.text();
  if (!content) throw new Error("Gemini returned empty response");
  return content;
}

async function callWithFallback(
  systemPrompt: string,
  userMessage: string,
  options: { maxTokens?: number; temperature?: number; jsonMode?: boolean } = {}
): Promise<string> {
  let primaryError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callGroq(systemPrompt, userMessage, options);
    } catch (err) {
      primaryError = err;
      if (!isRateLimitError(err)) throw err;

      const retryMs = parseRetryMs(err);

      if (retryMs > 30000 && gemini) {
        console.error(
          `[llm] Groq daily/long rate limit (retry in ${Math.round(retryMs / 1000)}s). Falling back to Gemini.`
        );
        try {
          return await callGemini(systemPrompt, userMessage, options);
        } catch (gemErr) {
          console.error(`[llm] Gemini fallback failed:`, gemErr instanceof Error ? gemErr.message : gemErr);
          throw gemErr;
        }
      }

      if (attempt === MAX_RETRIES) {
        if (gemini) {
          console.error(`[llm] Groq retries exhausted. Falling back to Gemini.`);
          try {
            return await callGemini(systemPrompt, userMessage, options);
          } catch (gemErr) {
            console.error(`[llm] Gemini fallback failed:`, gemErr instanceof Error ? gemErr.message : gemErr);
            throw gemErr;
          }
        }
        throw err;
      }

      const waitMs = Math.max(retryMs, 2000 * Math.pow(2, attempt));
      console.error(
        `[llm] Groq rate limited (attempt ${attempt + 1}/${MAX_RETRIES}). Waiting ${Math.ceil(waitMs)}ms...`
      );
      await sleep(waitMs);
    }
  }

  throw primaryError;
}

export async function callLLM(
  systemPrompt: string,
  userMessage: string,
  options: { maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  return callWithFallback(systemPrompt, userMessage, options);
}

export async function callLLMForJSON<T = unknown>(
  systemPrompt: string,
  userMessage: string,
  options: { maxTokens?: number; temperature?: number } = {}
): Promise<T> {
  const content = await callWithFallback(systemPrompt, userMessage, {
    ...options,
    jsonMode: true,
  });

  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error(`LLM returned invalid JSON: ${content.slice(0, 200)}...`);
  }
}
