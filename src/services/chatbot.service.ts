/**
 * Chatbot Service
 * Core RAG functionality using Cloudflare Workers AI and AI Gateway
 */

import { SupabaseClient } from "@supabase/supabase-js";
import {
  StoredDocument,
  ChatMessage,
  ChatSource,
  AI_GATEWAY_CONFIG,
  SYSTEM_PROMPT,
  GroqModelId,
  DEFAULT_MODEL,
} from "../types/chatbot.types";

// ============================================
// Embedding Generation
// ============================================

// Type for the embedding response
interface EmbeddingResponse {
  data?: number[][];
  shape?: number[];
}

/**
 * Generate embeddings using Cloudflare Workers AI
 * Uses @cf/baai/bge-large-en-v1.5 which produces 1024-dim vectors
 */
export async function generateEmbedding(
  ai: Ai,
  text: string
): Promise<number[]> {
  const response = (await ai.run("@cf/baai/bge-large-en-v1.5", {
    text: [text],
  })) as EmbeddingResponse;

  // Workers AI returns { data: [[...embedding]] } for text embeddings
  if (!response.data || !response.data[0]) {
    throw new Error("Failed to generate embedding");
  }

  return response.data[0];
}

/**
 * Generate embeddings for multiple texts
 */
export async function generateEmbeddings(
  ai: Ai,
  texts: string[]
): Promise<number[][]> {
  const response = (await ai.run("@cf/baai/bge-large-en-v1.5", {
    text: texts,
  })) as EmbeddingResponse;

  if (!response.data) {
    throw new Error("Failed to generate embeddings");
  }

  return response.data;
}

// ============================================
// Document Storage & Retrieval
// ============================================

/**
 * Store document chunks with embeddings in Supabase
 */
export async function storeDocuments(
  supabase: SupabaseClient,
  documents: Array<{
    content: string;
    embedding: number[];
    metadata?: Record<string, unknown>;
    company?: string;
    period?: string;
    content_type?: string;
  }>
): Promise<number> {
  const { data, error } = await supabase
    .from("chatbot_documents")
    .insert(
      documents.map((doc) => ({
        content: doc.content,
        embedding: JSON.stringify(doc.embedding),
        metadata: doc.metadata || {},
        company: doc.company || null,
        period: doc.period || null,
        content_type: doc.content_type || "text_chunk",
      }))
    )
    .select("id");

  if (error) {
    throw new Error(`Failed to store documents: ${error.message}`);
  }

  return data?.length || 0;
}

/**
 * Search for similar documents using pgvector
 */
export async function searchSimilarDocuments(
  supabase: SupabaseClient,
  queryEmbedding: number[],
  options: {
    limit?: number;
    company?: string;
    period?: string;
    content_type?: string;
    min_similarity?: number;
  } = {}
): Promise<StoredDocument[]> {
  const {
    limit = 5,
    company,
    period,
    content_type,
    min_similarity = 0.5,
  } = options;

  const { data, error } = await supabase.rpc("search_chatbot_documents", {
    query_embedding: JSON.stringify(queryEmbedding),
    match_limit: limit,
    filter_company: company || null,
    filter_period: period || null,
    filter_content_type: content_type || null,
  });

  if (error) {
    throw new Error(`Search failed: ${error.message}`);
  }

  // Filter by minimum similarity
  return (data || []).filter(
    (doc: StoredDocument) => (doc.similarity || 0) >= min_similarity
  );
}

// ============================================
// Chat Completion via AI Gateway
// ============================================

/**
 * Format retrieved documents into context string
 */
function formatContext(documents: StoredDocument[]): string {
  if (!documents.length) {
    return "No relevant context found.";
  }

  return documents
    .map((doc, i) => {
      const company = doc.company || "Unknown";
      const period = doc.period || "Unknown";
      const contentType = doc.content_type || "text";
      const similarity = doc.similarity?.toFixed(2) || "N/A";

      return `[Document ${
        i + 1
      }] (Company: ${company}, Period: ${period}, Type: ${contentType}, Relevance: ${similarity})
${doc.content}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Generate chat response using AI Gateway with Groq
 */
export async function generateChatResponse(
  apiKey: string,
  messages: ChatMessage[],
  context: StoredDocument[],
  userQuery: string,
  model: GroqModelId = DEFAULT_MODEL
): Promise<string> {
  const contextStr = formatContext(context);
  const systemPrompt = SYSTEM_PROMPT.replace("{context}", contextStr);

  // Build messages array for chat completion
  const chatMessages = [
    { role: "system", content: systemPrompt },
    ...messages.slice(-10).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { role: "user", content: userQuery },
  ];

  const response = await fetch(
    `${AI_GATEWAY_CONFIG.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: `groq/${model}`,
        messages: chatMessages,
        temperature: 0.7,
        max_tokens: 4096,
        top_p: 0.9,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI Gateway error: ${response.status} - ${errorText}`);
  }

  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (result.error) {
    throw new Error(`AI error: ${result.error.message}`);
  }

  const answer = result.choices?.[0]?.message?.content;
  if (!answer) {
    throw new Error("No response generated");
  }

  return answer.trim();
}

// ============================================
// Chat Session Management
// ============================================

/**
 * Create a new chat session
 */
export async function createChatSession(
  supabase: SupabaseClient,
  title: string
): Promise<string> {
  const { data, error } = await supabase
    .from("chat_sessions")
    .insert({ title })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to create session: ${error.message}`);
  }

  return data.id;
}

/**
 * Get a chat session with messages
 */
export async function getChatSession(
  supabase: SupabaseClient,
  sessionId: string
): Promise<{
  id: string;
  title: string;
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
} | null> {
  const { data: session, error: sessionError } = await supabase
    .from("chat_sessions")
    .select("*")
    .eq("id", sessionId)
    .single();

  if (sessionError || !session) {
    return null;
  }

  const { data: messages, error: messagesError } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (messagesError) {
    throw new Error(`Failed to get messages: ${messagesError.message}`);
  }

  return {
    ...session,
    messages: messages || [],
  };
}

/**
 * Get all chat sessions
 */
export async function getAllChatSessions(supabase: SupabaseClient): Promise<
  Array<{
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
    message_count: number;
  }>
> {
  const { data, error } = await supabase
    .from("chat_sessions")
    .select(
      `
      id,
      title,
      created_at,
      updated_at,
      chat_messages(count)
    `
    )
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to get sessions: ${error.message}`);
  }

  return (data || []).map((session) => ({
    id: session.id,
    title: session.title,
    created_at: session.created_at,
    updated_at: session.updated_at,
    message_count:
      (session.chat_messages as unknown as Array<{ count: number }>)?.[0]
        ?.count || 0,
  }));
}

/**
 * Add a message to a chat session
 */
export async function addChatMessage(
  supabase: SupabaseClient,
  sessionId: string,
  message: {
    role: "user" | "assistant";
    content: string;
    sources?: ChatSource[];
    model?: string;
  }
): Promise<number> {
  const { data, error } = await supabase
    .from("chat_messages")
    .insert({
      session_id: sessionId,
      role: message.role,
      content: message.content,
      sources: message.sources || [],
      model: message.model,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to add message: ${error.message}`);
  }

  return data.id;
}

/**
 * Delete a chat session
 */
export async function deleteChatSession(
  supabase: SupabaseClient,
  sessionId: string
): Promise<boolean> {
  const { error } = await supabase
    .from("chat_sessions")
    .delete()
    .eq("id", sessionId);

  if (error) {
    throw new Error(`Failed to delete session: ${error.message}`);
  }

  return true;
}

/**
 * Get chat history for context
 */
export async function getChatHistory(
  supabase: SupabaseClient,
  sessionId: string,
  limit: number = 10
): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return [];
  }

  return (data || []).reverse();
}
