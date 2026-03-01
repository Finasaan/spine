/**
 * Chatbot Types — FinasaanGPT v2
 * Clean types for the AI SDK v6-based streaming chatbot.
 */

// ============================================
// Model Configuration
// ============================================

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

export const DEFAULT_MODEL_ID = "llama-3.1-8b-instant";

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
