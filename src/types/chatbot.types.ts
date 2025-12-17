/**
 * Chatbot Types
 * TypeScript types for the RAG chatbot functionality
 */

// ============================================
// Groq Production Models
// ============================================

export const GROQ_MODELS = {
  "llama-3.1-8b-instant": {
    id: "llama-3.1-8b-instant",
    name: "Llama 3.1 8B Instant",
    provider: "groq",
  },
  "llama-3.3-70b-versatile": {
    id: "llama-3.3-70b-versatile",
    name: "Llama 3.3 70B Versatile",
    provider: "groq",
  },
  "openai/gpt-oss-120b": {
    id: "openai/gpt-oss-120b",
    name: "GPT OSS 120B",
    provider: "groq",
  },
  "openai/gpt-oss-20b": {
    id: "openai/gpt-oss-20b",
    name: "GPT OSS 20B",
    provider: "groq",
  },
} as const;

export type GroqModelId = keyof typeof GROQ_MODELS;

export const DEFAULT_MODEL: GroqModelId = "llama-3.1-8b-instant";

// ============================================
// Document Types
// ============================================

export interface DocumentChunk {
  text: string;
  metadata?: {
    company?: string;
    period?: string;
    content_type?: string;
    [key: string]: unknown;
  };
}

export interface StoredDocument {
  id: number;
  content: string;
  metadata: Record<string, unknown>;
  company: string | null;
  period: string | null;
  content_type: string;
  similarity?: number;
}

export interface IngestRequest {
  chunks: DocumentChunk[];
}

export interface IngestResponse {
  success: boolean;
  count: number;
  error?: string;
}

// ============================================
// Chat Types
// ============================================

export interface ChatMessage {
  id?: number;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  model?: string;
  created_at?: string;
}

export interface ChatSource {
  company?: string;
  period?: string;
  content_type?: string;
  similarity: number;
  snippet: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages?: ChatMessage[];
  created_at: string;
  updated_at: string;
}

export interface ChatRequest {
  query: string;
  chat_id?: string;
  model?: GroqModelId;
  company?: string;
  period?: string;
  top_k?: number;
}

export interface ChatResponse {
  chat_id: string;
  answer: string;
  sources: ChatSource[];
  metadata: {
    chunks_retrieved: number;
    model: string;
    filters_applied: {
      company?: string;
      period?: string;
    };
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

// ============================================
// System Prompt
// ============================================

export const SYSTEM_PROMPT = `You are a financial-document assistant. Your job is to answer questions about company reports, including financial statements, cash flow, and management discussion.

Key Guidelines:
1. Always prioritize accuracy and refer to the retrieved context provided below
2. If data is numerical, summarize it clearly with proper formatting
3. If the answer is not present in the retrieved documents, explicitly state: "I cannot find this information in the provided documents"
4. When citing financial figures, include the reporting period if available
5. Be concise but comprehensive in your responses
6. If asked about trends, compare data across periods when available
7. Always maintain a professional, factual tone

Retrieved Context:
{context}

Based on the above context, please answer the following question:`;
