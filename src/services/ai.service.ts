/**
 * AI Service
 * Provider factory using @ai-sdk/openai-compatible via Cloudflare AI Gateway.
 * All LLM providers are routed through the unified gateway endpoint.
 * Uses BYOK (Bring Your Own Key) — provider keys are stored on the gateway.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelConfig } from "../types/chatbot.types";

/**
 * Build a language model instance for a given model config.
 *
 * With BYOK enabled on the AI Gateway, we only need to authenticate
 * with the gateway itself via `cf-aig-authorization`. The gateway
 * injects the stored provider API key at runtime.
 *
 * Model string: "{gatewayProvider}/{model.id}"
 *   e.g. "groq/llama-3.3-70b-versatile"
 */
export function createModel(
  token: string,
  baseUrl: string,
  modelConfig: ModelConfig,
) {
  const provider = createOpenAICompatible({
    baseURL: baseUrl,
    name: "cf-ai-gateway",
    headers: {
      "cf-aig-authorization": `Bearer ${token}`,
    },
    // Do NOT set apiKey here — that would add an Authorization header
    // which overrides the BYOK key injection on the gateway side.
  });

  return provider(`${modelConfig.gatewayProvider}/${modelConfig.id}`);
}

/**
 * Generate text embeddings using Cloudflare Workers AI.
 * Uses @cf/baai/bge-large-en-v1.5 (1024-dim vectors).
 */
export async function generateEmbedding(
  ai: Ai,
  text: string,
  env?: { CLOUDFLARE_ACCOUNT_ID?: string; CLOUDFLARE_API_TOKEN?: string }
): Promise<number[]> {
  const data = await generateEmbeddings(ai, [text], env);
  return data[0];
}

// bge-large-en-v1.5 has a 512-token input cap. ~2000 chars is a safe bound
// that holds for table/numeric content where token density is high.
const EMBED_INPUT_MAX_CHARS = 2000;

function clipEmbeddingInputs(texts: string[]): string[] {
  return texts.map((t) =>
    t.length > EMBED_INPUT_MAX_CHARS ? t.slice(0, EMBED_INPUT_MAX_CHARS) : t
  );
}

async function runBindingWithRetry(
  ai: Ai,
  texts: string[]
): Promise<number[][]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = (await ai.run("@cf/baai/bge-large-en-v1.5", {
        text: texts,
      })) as { data?: number[][] };
      if (response.data) return response.data;
      throw new Error("Failed to generate embeddings: no data returned");
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

export async function generateEmbeddings(
  ai: Ai,
  texts: string[],
  env?: { CLOUDFLARE_ACCOUNT_ID?: string; CLOUDFLARE_API_TOKEN?: string }
): Promise<number[][]> {
  const safeTexts = clipEmbeddingInputs(texts);

  try {
    return await runBindingWithRetry(ai, safeTexts);
  } catch (error: any) {
    if (env?.CLOUDFLARE_API_TOKEN && env?.CLOUDFLARE_ACCOUNT_ID) {
      console.warn(
        "[generateEmbeddings] AI binding failed after retries, falling back to direct HTTP:",
        error instanceof Error ? error.message : error
      );
      const resp = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/baai/bge-large-en-v1.5`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text: safeTexts }),
        }
      );

      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Workers AI direct embedding failed (${resp.status}): ${body.slice(0, 200)}`);
      }

      const result = await resp.json() as { result?: { data: number[][] } };
      if (result.result?.data) return result.result.data;
      throw new Error("Workers AI direct embedding returned no data");
    }
    throw error;
  }
}





