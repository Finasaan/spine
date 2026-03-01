/**
 * Chatbot Controller
 * Handles HTTP requests for chatbot endpoints
 * Routes between insurance and stocks knowledge bases
 */

import { Context } from "hono";
import { getSupabaseClient } from "../db";
import {
  generateEmbedding,
  generateEmbeddings,
  storeDocuments,
  searchSimilarDocuments,
  createChatSession,
  getChatSession,
  getAllChatSessions,
  addChatMessage,
  deleteChatSession,
  getChatHistory,
} from "../services/chatbot.service";
import {
  searchInsuranceChunks,
} from "../services/insurance.service";
import {
  ChatRequest,
  IngestRequest,
  GroqModelId,
  DEFAULT_MODEL,
  GROQ_MODELS,
  ChatSource,
  ChatDomain,
  STOCKS_SYSTEM_PROMPT,
  INSURANCE_SYSTEM_PROMPT,
  AI_GATEWAY_CONFIG,
  detectQueryDomain,
  buildBudgetedMessages,
} from "../types/chatbot.types";

// ============================================
// Helper Functions
// ============================================

function getAIGatewayToken(c: Context<{ Bindings: CloudflareBindings }>) {
  // AI_GATEWAY_TOKEN is set in .dev.vars for local dev and as a secret in production
  const token = (c.env as unknown as { AI_GATEWAY_TOKEN: string })
    .AI_GATEWAY_TOKEN;
  if (!token) {
    throw new Error("AI_GATEWAY_TOKEN not configured");
  }
  return token;
}

// ============================================
// Chat Endpoint
// ============================================

/**
 * Handle chat request with RAG
 * POST /api/chatbot/chat
 *
 * Automatically detects whether the query is about insurance or stocks
 * and routes to the appropriate knowledge base
 */
export async function handleChat(c: Context<{ Bindings: CloudflareBindings }>) {
  try {
    const body = await c.req.json<ChatRequest>();

    // Validate request
    if (!body.query?.trim()) {
      return c.json({ error: "No query provided" }, 400);
    }

    const query = body.query.trim();
    const model =
      body.model && body.model in GROQ_MODELS ? body.model : DEFAULT_MODEL;
    const topK = body.top_k || 5;

    const supabase = await getSupabaseClient(c.env);
    const aiGatewayToken = getAIGatewayToken(c);
    const ai = c.env.AI;

    // Determine domain: explicit from request, or auto-detect from query
    const domain: ChatDomain =
      body.domain && body.domain !== "auto"
        ? body.domain
        : detectQueryDomain(query);

    console.log(`[Chat] Domain: ${domain} | Query: ${query.substring(0, 80)}`);

    // Get or create chat session
    let chatId = body.chat_id;
    if (!chatId) {
      const title = query.length > 50 ? query.substring(0, 50) + "..." : query;
      chatId = await createChatSession(supabase, title);
    } else {
      // Verify session exists
      const existing = await getChatSession(supabase, chatId);
      if (!existing) {
        return c.json({ error: `Chat session ${chatId} not found` }, 404);
      }
    }

    // Step 1: Generate query embedding
    const queryEmbedding = await generateEmbedding(ai, query);

    // Step 2: Search the appropriate knowledge base
    let answer: string;
    let sources: ChatSource[] = [];
    let chunksRetrieved = 0;

    if (domain === "insurance") {
      // --- Insurance domain ---
      const insuranceResults = await searchInsuranceChunks(
        supabase,
        queryEmbedding,
        {
          limit: topK,
          company_id: body.company,
          min_similarity: 0.5,
        }
      );

      chunksRetrieved = insuranceResults.length;

      if (insuranceResults.length === 0) {
        answer =
          "I couldn't find any relevant insurance information in the documents to answer your question. Try rephrasing or ask about a specific insurance company or product.";
      } else {
        // Get chat history
        const history = await getChatHistory(supabase, chatId);

        // Format each chunk as a labeled context block (already sorted by relevance)
        const contextChunks = insuranceResults.map((r, i) => {
          const company = r.company_id || "Unknown";
          const chunkType = r.chunk_type || "body";
          const similarity = r.similarity?.toFixed(2) || "N/A";
          return `[Insurance Document ${i + 1}] (Company: ${company}, Type: ${chunkType}, Relevance: ${similarity})\n${r.text}`;
        });

        // Build token-budgeted messages — drops chunks/history that don't fit
        const { messages: chatMessages, maxResponseTokens } = buildBudgetedMessages({
          systemPromptTemplate: INSURANCE_SYSTEM_PROMPT,
          contextChunks,
          history: history.slice(-10).map((m) => ({
            role: m.role,
            content: m.content,
          })),
          userQuery: query,
          model,
        });

        // Generate response via AI Gateway
        const response = await fetch(
          `${AI_GATEWAY_CONFIG.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "cf-aig-authorization": `Bearer ${aiGatewayToken}`,
            },
            body: JSON.stringify({
              model: `groq/${model}`,
              messages: chatMessages,
              temperature: 0.7,
              max_tokens: maxResponseTokens,
              top_p: 0.9,
            }),
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `AI Gateway error: ${response.status} - ${errorText}`
          );
        }

        const result = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          error?: { message?: string };
        };

        if (result.error) {
          throw new Error(`AI error: ${result.error.message}`);
        }

        answer = result.choices?.[0]?.message?.content?.trim() || "";
        if (!answer) throw new Error("No response generated");

        // Prepare sources from insurance results
        sources = insuranceResults.map((r) => ({
          company: r.company_id || undefined,
          content_type: r.chunk_type || undefined,
          similarity: Math.round((r.similarity || 0) * 1000) / 1000,
          snippet:
            r.text.length > 200 ? r.text.substring(0, 200) + "..." : r.text,
        }));
      }
    } else {
      // --- Stocks domain (existing behavior) ---
      const relevantDocs = await searchSimilarDocuments(
        supabase,
        queryEmbedding,
        {
          limit: topK,
          company: body.company,
          period: body.period,
          min_similarity: 0.5,
        }
      );

      chunksRetrieved = relevantDocs.length;

      if (relevantDocs.length === 0) {
        answer =
          "I couldn't find any relevant information in the documents to answer your question.";
      } else {
        const history = await getChatHistory(supabase, chatId);

        // Format each doc as a labeled context block
        const contextChunks = relevantDocs.map((doc, i) => {
          const company = doc.company || "Unknown";
          const period = doc.period || "Unknown";
          const contentType = doc.content_type || "text";
          const similarity = doc.similarity?.toFixed(2) || "N/A";
          return `[Document ${i + 1}] (Company: ${company}, Period: ${period}, Type: ${contentType}, Relevance: ${similarity})\n${doc.content}`;
        });

        // Build token-budgeted messages
        const { messages: chatMessages, maxResponseTokens } = buildBudgetedMessages({
          systemPromptTemplate: STOCKS_SYSTEM_PROMPT,
          contextChunks,
          history: history.slice(-10).map((m) => ({
            role: m.role,
            content: m.content,
          })),
          userQuery: query,
          model,
        });

        // Generate response via AI Gateway
        const gatewayResponse = await fetch(
          `${AI_GATEWAY_CONFIG.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "cf-aig-authorization": `Bearer ${aiGatewayToken}`,
            },
            body: JSON.stringify({
              model: `groq/${model}`,
              messages: chatMessages,
              temperature: 0.7,
              max_tokens: maxResponseTokens,
              top_p: 0.9,
            }),
          }
        );

        if (!gatewayResponse.ok) {
          const errorText = await gatewayResponse.text();
          throw new Error(
            `AI Gateway error: ${gatewayResponse.status} - ${errorText}`
          );
        }

        const result = (await gatewayResponse.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          error?: { message?: string };
        };

        if (result.error) {
          throw new Error(`AI error: ${result.error.message}`);
        }

        answer = result.choices?.[0]?.message?.content?.trim() || "";
        if (!answer) throw new Error("No response generated");

        sources = relevantDocs.map((doc) => ({
          company: doc.company || undefined,
          period: doc.period || undefined,
          content_type: doc.content_type || undefined,
          similarity: Math.round((doc.similarity || 0) * 1000) / 1000,
          snippet:
            doc.content.length > 200
              ? doc.content.substring(0, 200) + "..."
              : doc.content,
        }));
      }
    }

    // Step 3: Save messages to database
    await addChatMessage(supabase, chatId, {
      role: "user",
      content: query,
    });
    await addChatMessage(supabase, chatId, {
      role: "assistant",
      content: answer,
      sources,
      model,
    });

    return c.json({
      chat_id: chatId,
      answer,
      sources,
      metadata: {
        chunks_retrieved: chunksRetrieved,
        model,
        domain,
        filters_applied: {
          company: body.company,
          period: body.period,
        },
      },
    });
  } catch (error) {
    console.error("Chat error:", error);
    return c.json(
      {
        error: "Chat processing failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
}

// ============================================
// Document Ingestion
// ============================================

/**
 * Ingest document chunks
 * POST /api/chatbot/documents
 */
export async function handleIngestDocuments(
  c: Context<{ Bindings: CloudflareBindings }>
) {
  try {
    const body = await c.req.json<IngestRequest>();

    if (
      !body.chunks ||
      !Array.isArray(body.chunks) ||
      body.chunks.length === 0
    ) {
      return c.json({ error: "No chunks provided" }, 400);
    }

    const supabase = await getSupabaseClient(c.env);
    const ai = c.env.AI;

    // Extract texts for batch embedding
    const texts = body.chunks.map((chunk) => chunk.text);

    // Generate embeddings in batch
    const embeddings = await generateEmbeddings(ai, texts);

    // Prepare documents for storage
    const documents = body.chunks.map((chunk, i) => ({
      content: chunk.text,
      embedding: embeddings[i],
      metadata: chunk.metadata || {},
      company: chunk.metadata?.company as string | undefined,
      period: chunk.metadata?.period as string | undefined,
      content_type: (chunk.metadata?.content_type as string) || "text_chunk",
    }));

    // Store in database
    const count = await storeDocuments(supabase, documents);

    return c.json({
      success: true,
      count,
    });
  } catch (error) {
    console.error("Ingestion error:", error);
    return c.json(
      {
        success: false,
        error: "Document ingestion failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
}

// ============================================
// PDF Document Upload
// ============================================

/**
 * Upload and process PDF document
 * POST /api/chatbot/documents/upload
 */
export async function handleUploadPDF(
  c: Context<{ Bindings: CloudflareBindings }>
) {
  try {
    // Parse multipart form data
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    const company = formData.get("company") as string | null;
    const period = formData.get("period") as string | null;

    if (!file) {
      return c.json({ error: "No PDF file provided" }, 400);
    }

    // Validate file type
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return c.json({ error: "Only PDF files are allowed" }, 400);
    }

    // Max file size: 10MB
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      return c.json({ error: "File too large. Maximum size is 10MB" }, 400);
    }

    console.log(`Processing PDF: ${file.name} (${file.size} bytes)`);

    // Import PDF processing service
    const { processPDF } = await import("../services/pdf.service");

    // Step 1: Extract text and chunk
    const pdfBuffer = await file.arrayBuffer();
    const chunks = await processPDF(
      pdfBuffer,
      company || undefined,
      period || undefined
    );

    console.log(`Extracted ${chunks.length} chunks from PDF`);

    const supabase = await getSupabaseClient(c.env);
    const ai = c.env.AI;

    // Step 2: Generate embeddings in batch
    const texts = chunks.map((chunk) => chunk.text);
    const embeddings = await generateEmbeddings(ai, texts);

    // Step 3: Prepare documents for storage
    const documents = chunks.map((chunk, i) => ({
      content: chunk.text,
      embedding: embeddings[i],
      metadata: chunk.metadata,
      company: chunk.metadata.company,
      period: chunk.metadata.period,
      content_type: chunk.metadata.content_type,
    }));

    // Step 4: Store in database
    const count = await storeDocuments(supabase, documents);

    return c.json({
      success: true,
      message: "PDF processed and ingested successfully",
      statistics: {
        filename: file.name,
        company: company || "Not specified",
        period: period || "Not specified",
        chunks_created: chunks.length,
        documents_stored: count,
      },
    });
  } catch (error) {
    console.error("PDF upload error:", error);
    return c.json(
      {
        success: false,
        error: "PDF processing failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
}

// ============================================
// Chat Session Management
// ============================================

/**
 * Get all chat sessions
 * GET /api/chatbot/chats
 */
export async function handleGetChats(
  c: Context<{ Bindings: CloudflareBindings }>
) {
  try {
    const supabase = await getSupabaseClient(c.env);
    const sessions = await getAllChatSessions(supabase);

    return c.json({
      chats: sessions,
      count: sessions.length,
    });
  } catch (error) {
    console.error("Get chats error:", error);
    return c.json(
      {
        error: "Failed to retrieve chats",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
}

/**
 * Get a specific chat session
 * GET /api/chatbot/chats/:id
 */
export async function handleGetChat(
  c: Context<{ Bindings: CloudflareBindings }>
) {
  try {
    const chatId = c.req.param("id");
    if (!chatId) {
      return c.json({ error: "Chat ID required" }, 400);
    }

    const supabase = await getSupabaseClient(c.env);
    const session = await getChatSession(supabase, chatId);

    if (!session) {
      return c.json({ error: "Chat not found" }, 404);
    }

    return c.json(session);
  } catch (error) {
    console.error("Get chat error:", error);
    return c.json(
      {
        error: "Failed to retrieve chat",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
}

/**
 * Delete a chat session
 * DELETE /api/chatbot/chats/:id
 */
export async function handleDeleteChat(
  c: Context<{ Bindings: CloudflareBindings }>
) {
  try {
    const chatId = c.req.param("id");
    if (!chatId) {
      return c.json({ error: "Chat ID required" }, 400);
    }

    const supabase = await getSupabaseClient(c.env);
    await deleteChatSession(supabase, chatId);

    return c.json({
      success: true,
      message: `Chat session ${chatId} deleted successfully`,
    });
  } catch (error) {
    console.error("Delete chat error:", error);
    return c.json(
      {
        error: "Failed to delete chat",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
}

/**
 * Get available models
 * GET /api/chatbot/models
 */
export async function handleGetModels(
  c: Context<{ Bindings: CloudflareBindings }>
) {
  const models = Object.values(GROQ_MODELS).map((m) => ({
    id: m.id,
    name: m.name,
  }));

  return c.json({
    models,
    default: DEFAULT_MODEL,
  });
}
