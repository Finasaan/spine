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
): Promise<number[]> {
  const response = (await ai.run("@cf/baai/bge-large-en-v1.5", {
    text: [text],
  })) as { data?: number[][] };

  if (!response.data?.[0]) {
    throw new Error("Failed to generate embedding: no data returned");
  }

  return response.data[0];
}

/**
 * Generate embeddings for multiple texts in a single batch request.
 */
export async function generateEmbeddings(
  ai: Ai,
  texts: string[],
): Promise<number[][]> {
  try {
    const response = (await ai.run("@cf/baai/bge-large-en-v1.5", {
      text: texts,
    })) as { data?: number[][] };

    if (!response.data) {
      throw new Error("Failed to generate embeddings: no data returned");
    }

    return response.data;
  } catch (error) {
    if (error instanceof Error && error.message.includes("1031")) {
      throw new Error(
        "Workers AI unavailable in local dev. Run with: wrangler dev --remote",
      );
    }
    throw error;
  }
}
