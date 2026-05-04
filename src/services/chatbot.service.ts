/**
 * Chatbot Service — FinasaanGPT v2
 * Session management, message persistence, and document upload helpers.
 * LLM / streaming logic lives in chatbot.controller.ts.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { generateEmbedding, generateEmbeddings } from "./ai.service";
import type { ChatSession, ChatMessageRecord } from "../types/chatbot.types";

// ============================================
// Sanitization
// ============================================

/**
 * Strip characters that PostgreSQL rejects when payloads arrive as JSON
 * via PostgREST: null bytes (U+0000) and lone UTF-16 surrogates. PDF text
 * extraction commonly leaks these from binary streams, producing the error
 * "unsupported Unicode escape sequence" on insert.
 */
function sanitizeForPostgres(value: string): string {
  return value
    .replace(new RegExp(String.fromCharCode(0), "g"), "")
    .replace(/[\uD800-\uDFFF]/g, "");
}

function sanitizeMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === "string") {
      out[k] = sanitizeForPostgres(v);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = sanitizeMetadata(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === "string" ? sanitizeForPostgres(item) : item
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ============================================
// Hash Utility
// ============================================

export async function computeDocumentHash(
  content: string | ArrayBuffer
): Promise<string> {
  const bytes =
    typeof content === "string"
      ? new TextEncoder().encode(content)
      : new Uint8Array(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================
// Unified Knowledge Base (finasaan_documents)
// ============================================

/**
 * Check if a document with the given hash already exists in finasaan_documents.
 * Used for dedup in the hybrid PDF pipeline.
 */
export async function finasaanDocumentExists(
  supabase: SupabaseClient,
  documentHash: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("finasaan_documents")
    .select("id")
    .eq("document_hash", documentHash)
    .limit(1);

  if (error) {
    console.warn(`[Chatbot] finasaan_documents hash check error: ${error.message}`);
    return false; // Proceed with ingestion on error
  }

  return (data?.length || 0) > 0;
}

/**
 * Store prose chunks with embeddings in the unified finasaan_documents table.
 * Used by the hybrid PDF pipeline for prose text (Path A and vision prose).
 *
 * @param supabase - Supabase client
 * @param documents - Array of content + embedding + metadata objects
 * @param documentHash - SHA-256 hash of the source PDF for dedup
 * @param domain - Knowledge base domain (default: 'financials')
 * @returns Number of rows inserted
 */
export async function storeFinasaanDocuments(
  supabase: SupabaseClient,
  documents: Array<{
    content: string;
    embedding: number[];
    metadata?: Record<string, unknown>;
  }>,
  documentHash: string,
  domain: string = "financials"
): Promise<number> {
  if (documents.length === 0) return 0;

  const { data, error } = await supabase
    .from("finasaan_documents")
    .insert(
      documents.map((doc) => ({
        domain,
        content: sanitizeForPostgres(doc.content),
        embedding: JSON.stringify(doc.embedding),
        metadata: sanitizeMetadata(doc.metadata || {}),
        document_hash: documentHash,
      }))
    )
    .select("id");

  if (error) {
    throw new Error(`Failed to store finasaan_documents: ${error.message}`);
  }

  return data?.length || 0;
}

// ============================================
// Session Management
// ============================================

/**
 * Get an existing session (verifying it belongs to the user),
 * or create a new one if sessionId is null.
 */
export async function getOrCreateSession(
  supabase: SupabaseClient,
  userId: string,
  sessionId: string | null,
  title: string,
  modelId: string
): Promise<ChatSession> {
  if (sessionId) {
    const { data, error } = await supabase
      .from("chat_sessions")
      .select("*")
      .eq("id", sessionId)
      .eq("user_id", userId)
      .single();

    if (error || !data) {
      throw new Error(`Session ${sessionId} not found or access denied`);
    }

    return data as unknown as ChatSession;
  }

  // Create new session
  const { data, error } = await supabase
    .from("chat_sessions")
    .insert({
      title: title.length > 60 ? title.substring(0, 57) + "..." : title,
      user_id: userId,
      model: modelId,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to create session: ${error?.message}`);
  }

  return data as unknown as ChatSession;
}

/**
 * Persist user and assistant messages after a stream completes.
 */
export async function persistMessages(
  supabase: SupabaseClient,
  sessionId: string,
  userContent: string,
  assistantContent: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const now = new Date().toISOString();

  await supabase.from("chat_messages").insert([
    {
      session_id: sessionId,
      role: "user",
      content: userContent,
      metadata: {},
      created_at: now,
    },
    {
      session_id: sessionId,
      role: "assistant",
      content: assistantContent,
      metadata,
      created_at: new Date(Date.now() + 1).toISOString(),
    },
  ]);

  // Update session's updated_at
  await supabase
    .from("chat_sessions")
    .update({ updated_at: now })
    .eq("id", sessionId);
}

/**
 * Get all sessions for a user (ordered newest first).
 */
export async function getUserSessions(
  supabase: SupabaseClient,
  userId: string
): Promise<
  Array<{
    id: string;
    title: string;
    model: string | null;
    created_at: string;
    updated_at: string;
    message_count: number;
  }>
> {
  const { data, error } = await supabase
    .from("chat_sessions")
    .select(
      `
      id, title, model, created_at, updated_at,
      chat_messages(count)
    `
    )
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) {
    throw new Error(`Failed to get sessions: ${error.message}`);
  }

  return (data || []).map((s: Record<string, unknown>) => ({
    id: s.id as string,
    title: s.title as string,
    model: s.model as string | null,
    created_at: s.created_at as string,
    updated_at: s.updated_at as string,
    message_count:
      (s.chat_messages as unknown as Array<{ count: number }>)?.[0]?.count ||
      0,
  }));
}

/**
 * Get a session's messages for a specific user.
 */
export async function getSessionMessages(
  supabase: SupabaseClient,
  sessionId: string,
  userId: string
): Promise<{ session: ChatSession; messages: ChatMessageRecord[] } | null> {
  const { data: session, error: sErr } = await supabase
    .from("chat_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .single();

  if (sErr || !session) return null;

  const { data: messages, error: mErr } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (mErr) throw new Error(`Failed to get messages: ${mErr.message}`);

  return {
    session: session as unknown as ChatSession,
    messages: (messages || []) as unknown as ChatMessageRecord[],
  };
}

/**
 * Delete a session (and cascade-delete its messages and conversation chunks).
 */
export async function deleteSession(
  supabase: SupabaseClient,
  sessionId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from("chat_sessions")
    .delete()
    .eq("id", sessionId)
    .eq("user_id", userId);

  if (error) throw new Error(`Failed to delete session: ${error.message}`);
}

// ============================================
// Conversation Document Upload
// ============================================

/**
 * Extract text from a PDF file, chunk it, embed chunks, and store
 * in conversation_document_chunks (scoped to session + user).
 * The actual file bytes are never stored.
 */
export async function uploadConversationDocument(
  supabase: SupabaseClient,
  ai: Ai,
  sessionId: string,
  userId: string,
  file: File,
  env?: { CLOUDFLARE_ACCOUNT_ID?: string; CLOUDFLARE_API_TOKEN?: string }
): Promise<{ filename: string; chunksCreated: number }> {
  // Validate file
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    throw new Error("Only PDF files are supported");
  }
  if (file.size > 50 * 1024 * 1024) {
    throw new Error("File too large — maximum 50MB");
  }

  // Extract text
  const pdfBuffer = await file.arrayBuffer();
  const { processPDF } = await import("./pdf.service");
  const chunks = await processPDF(pdfBuffer);

  if (chunks.length === 0) {
    throw new Error("No text content extracted from PDF");
  }

  // Generate embeddings in batch
  const texts = chunks.map((c) => c.text);
  const embeddings = await generateEmbeddings(ai, texts, env);

  // Store chunks
  const records = chunks.map((chunk, i) => ({
    session_id: sessionId,
    user_id: userId,
    filename: sanitizeForPostgres(file.name),
    chunk_index: chunk.metadata.chunk_index,
    content: sanitizeForPostgres(chunk.text),
    embedding: JSON.stringify(embeddings[i]),
  }));

  const { error } = await supabase
    .from("conversation_document_chunks")
    .insert(records);

  if (error) {
    throw new Error(`Failed to store document chunks: ${error.message}`);
  }

  return { filename: file.name, chunksCreated: chunks.length };
}

// ============================================
// Knowledge Base Document Storage (legacy upload endpoint)
// ============================================

/**
 * Check if a document with the given hash already exists in finasaan_documents.
 */
export async function documentExists(
  supabase: SupabaseClient,
  documentHash: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("finasaan_documents")
    .select("id")
    .eq("document_hash", documentHash)
    .limit(1);

  if (error) return false;
  return (data?.length || 0) > 0;
}

/**
 * Store document chunks into the unified finasaan_documents table.
 */
export async function storeKnowledgeDocuments(
  supabase: SupabaseClient,
  documents: Array<{
    content: string;
    embedding: number[];
    domain: string;
    metadata?: Record<string, unknown>;
    documentHash?: string;
  }>
): Promise<number> {
  const { data, error } = await supabase
    .from("finasaan_documents")
    .insert(
      documents.map((doc) => ({
        domain: doc.domain,
        content: sanitizeForPostgres(doc.content),
        embedding: JSON.stringify(doc.embedding),
        metadata: sanitizeMetadata(doc.metadata || {}),
        document_hash: doc.documentHash || null,
      }))
    )
    .select("id");

  if (error) throw new Error(`Failed to store documents: ${error.message}`);
  return data?.length || 0;
}
