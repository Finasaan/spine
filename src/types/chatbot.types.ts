/**
 * Chatbot Types — FinasaanGPT v2
 * Clean types for the AI SDK v6-based streaming chatbot.
 */

// ============================================
// Model Configuration
// ============================================

export const GROQ_MODELS = {
  "llama-3.1-8b-instant": {
    id: "llama-3.1-8b-instant",
    name: "Llama 3.1 8B Instant",
    provider: "groq",
    /** Max context window (input + output) on Groq free tier */
    maxTokens: 131072,
  },
  "llama-3.3-70b-versatile": {
    id: "llama-3.3-70b-versatile",
    name: "Llama 3.3 70B Versatile",
    provider: "groq",
    maxTokens: 131072,
  },
  "llama-3.2-11b-vision-preview": {
    id: "llama-3.2-11b-vision-preview",
    name: "Llama 3.2 11B Vision Preview",
    provider: "groq",
    maxTokens: 8192,
  },
  "meta-llama/llama-4-scout-17b-16e-instruct": {
    id: "meta-llama/llama-4-scout-17b-16e-instruct",
    name: "Llama 4 Scout 17B Vision",
    provider: "groq",
    maxTokens: 131072,
  },
  "openai/gpt-oss-120b": {
    id: "openai/gpt-oss-120b",
    name: "GPT OSS 120B",
    provider: "groq",
    /** Free tier TPM limit is 8000 — input + output combined */
    maxTokens: 8000,
  },
  "openai/gpt-oss-20b": {
    id: "openai/gpt-oss-20b",
    name: "GPT OSS 20B",
    provider: "groq",
    maxTokens: 8000,
  },
} as const;

export type GroqModelId = keyof typeof GROQ_MODELS;

/**
 * Get the token limit for a given model
 * Falls back to a conservative 8000 if unknown
 */
export function getModelTokenLimit(model: GroqModelId): number {
  return GROQ_MODELS[model]?.maxTokens ?? 8000;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  gatewayProvider: string;
  isPro: boolean;
  isEnabled: boolean;
  supportsToolCalling: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  description: string;
}

// ============================================
// Chat Session Types
// ============================================

export interface ChatSession {
  id: string;
  title: string;
  user_id: string;
  model: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

export interface ChatMessageRecord {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ============================================
// Document / Knowledge Types
// ============================================

export interface FinasaanDocument {
  id: number;
  domain: string;
  content: string;
  metadata: Record<string, unknown>;
  source_url: string | null;
  similarity?: number;
}

export interface ConversationChunk {
  id: number;
  filename: string;
  chunk_index: number;
  content: string;
  similarity?: number;
}

// ============================================
// Stream Request Types
// ============================================

export interface StreamRequest {
  /** AI SDK UIMessage array from the client */
  messages: Array<{ role: string; content: string | unknown[] }>;
  /** Session ID (null = new session) */
  sessionId: string | null;
  /** Model ID from models.json */
  modelId: string;
  /** Optional page context for mini-assistant */
  pageContext?: {
    url: string;
    content?: string;
  };
}

export interface UploadAttachmentRequest {
  sessionId: string;
}

// ============================================
// Legacy compatibility (kept for pdf upload endpoint)
// ============================================

export interface DocumentChunk {
  text: string;
  metadata: {
    company?: string;
    period?: string;
    content_type: string;
    chunk_index: number;
    total_chunks: number;
    char_start: number;
    char_end: number;
  };
}

// ============================================
// AI Gateway Configuration
// ============================================

export const AI_GATEWAY_CONFIG = {
  accountId: "345590cd19a379d6bf1008c6a7860451",
  gatewayId: "chatbot-preview",
  get baseUrl() {
    return `https://gateway.ai.cloudflare.com/v1/${this.accountId}/${this.gatewayId}/compat`;
  },
} as const;
