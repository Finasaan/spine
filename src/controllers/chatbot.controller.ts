/**
 * Chatbot Controller — FinasaanGPT v2
 * Streaming AI responses via AI SDK v6 + Cloudflare AI Gateway.
 */

import { Context } from "hono";
import { streamText, stepCountIs, convertToModelMessages } from "ai";
import { getSupabaseAdminClient } from "../db";
import { createModel } from "../services/ai.service";
import { createAllTools } from "../services/tools";
import {
  getOrCreateSession,
  persistMessages,
  getUserSessions,
  getSessionMessages,
  deleteSession,
  uploadConversationDocument,
  storeFinasaanDocuments,
  finasaanDocumentExists,
  computeDocumentHash,
} from "../services/chatbot.service";
import { generateEmbeddings } from "../services/ai.service";
import {
  extractPageViaVision,
  isVisionTableValid,
  buildExtractedTableRecord,
  storeExtractedTable,
  storeExtractedTables,
} from "../services/extraction.service";
import {
  extractPerPageTexts,
  isTableHeavyPage,
  renderPageToBase64PNG,
  countNonWhitespace,
  chunkText,
} from "../services/pdf.service";
import type { StreamRequest, ModelConfig } from "../types/chatbot.types";
import modelsConfig from "../config/models.json";

// ============================================
// Constants
// ============================================

const MODELS: ModelConfig[] = modelsConfig as ModelConfig[];
const DEFAULT_MODEL_ID = "gemini-2.5-flash-lite";
const SYSTEM_PROMPT = `You are FinasaanGPT, an AI financial intelligence assistant for Finasaan — Pakistan's premier investment platform covering PSX stocks, mutual funds, and insurance.

Persona: Direct, precise, data-driven. You speak like a Bloomberg terminal with manners.
Language: Mirror the user's language — if they write in Urdu or Roman Urdu, respond in kind.

Rules:
- Always use tools before answering data questions. Never hallucinate prices or statistics.
- Keep responses dense and structured. Use markdown tables for comparisons.
- Answer investment-related questions thoroughly using all available data and tools. When your response could reasonably be interpreted as investment advice (buy/sell signals, valuations, stock picks, fund recommendations), always end with: "⚠️ Not investment advice. Always do your own research before acting."
- For PSX stocks: always include ticker symbol, price, and % change when available.
- For mutual funds: always mention NAV, fund category, and management company.
- For insurance: always reference the specific policy/company from the knowledge base.
- For taxation: use searchTaxDocs to query Pakistan tax laws, ordinances, and FBR circulars.
- Cite your sources at the end of data-heavy responses.

Tool usage strategy:
- When the user asks about an uploaded document or file: ALWAYS call searchConversationDocument first.
- For specific financial figures from company reports (revenue, profit, assets, EPS, balance sheet items, income statement line items, cash flows): ALWAYS use queryFinancialTables first. This tool has structured numerical data — use it for precise numbers and comparisons. When the response includes a fallbackResults array, those are real ingested-document chunks for the requested company/period — read them and answer from them. Only conclude "no data" if BOTH the tables array AND the fallbackResults array are empty.
- If queryFinancialTables returns nothing for either field, then call searchKnowledge with the same company and period filters as a final attempt before giving up.
- For general information, qualitative analysis, management commentary, or notes from reports: use searchKnowledge with domain='financials' and pass the company name and period as filters.
- searchKnowledge supports company and period filters — ALWAYS pass these when the user asks about a specific company or time period. Example: searchKnowledge({query: "operating profit", domain: "financials", company: "PTCL", period: "Q1 2026"}).
- For financial analysis questions: chain queryFinancialTables (for structured numbers) with searchKnowledge (for qualitative context + unstructured numbers). Present numbers in markdown tables.
- Company name matching: Both queryFinancialTables and searchKnowledge automatically resolve tickers and company name variations (e.g. "NPL" → "Nishat Power Limited", "PTCL" → "Pakistan Telecommunication Company Ltd"). You do NOT need to resolve names yourself — just pass whatever the user said.
- If queryFinancialTables returns no results for a company, try searchCompanies to verify the company exists, then retry with the exact company_name from the result.
- For "best performing", "top", or ranking questions: use queryMutualFunds or getTopStocks with appropriate sortBy and sortOrder desc.
- For period-based returns (e.g. "best fund over 5 years"): use queryMutualFunds with sortBy='return' and returnPeriodMonths (12=1yr, 36=3yr, 60=5yr).
- For category-specific queries (equity funds, money market, Islamic): use the category filter on queryMutualFunds.
- For provider/AMC-specific queries (e.g. "HBL funds"): first call getFundProviders, then queryMutualFunds with providerId.
- For sector-specific stock queries (banking stocks, cement sector): first call listSectors to find the sector ID, then use getTopStocks or searchCompanies with sectorId.
- For performance trends or historical analysis: use getFundNavHistory (up to 5 years) or getStockHistory (up to 5 years).
- For insurance, financial literacy, or general knowledge questions: use searchKnowledge with the appropriate domain filter.
- For taxation questions (slabs, ordinance, rules, exemptions): ALWAYS use searchTaxDocs.
- Chain multiple tools when needed — e.g., queryFinancialTables to find financial data, then searchKnowledge for qualitative context.
- For comparison questions: retrieve data for all items being compared, then present in a markdown table.
- For recent Pakistan economic news, market events, or "what's happening" questions: call getRecentHeadlines first for a broad view, then searchRecentNews for topic-specific semantic retrieval.
- When citing news, always include the source name and publication date at the end of the response.
- Always try to answer the query using available tools. Only say you cannot if no combination of tools can produce the answer.
`;

// ============================================
// Helper
// ============================================

function resolveModel(modelId?: string): ModelConfig {
  const id = modelId ?? DEFAULT_MODEL_ID;
  return (
    MODELS.find((m) => m.id === id && m.isEnabled) ??
    MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!
  );
}

// ============================================
// POST /api/chatbot/stream
// ============================================

export async function handleStream(
  c: Context<{ Bindings: CloudflareBindings }>,
) {
  try {
    const body = await c.req.json<StreamRequest>();
    const { messages, sessionId, modelId } = body;

    if (!messages?.length) {
      return c.json({ error: "No messages provided" }, 400);
    }

    const user = c.get("user");
    const supabase = await getSupabaseAdminClient(c.env);
    const modelConfig = resolveModel(modelId);

    // Dynamic system prompt with current date/time
    const now = new Date();
    const currentDateTime = now.toLocaleString("en-PK", {
      timeZone: "Asia/Karachi",
      dateStyle: "full",
      timeStyle: "long",
    });
    const fullSystemPrompt = `${SYSTEM_PROMPT}\n\nCurrent Date and Time (Karachi): ${currentDateTime}`;

    const model = createModel(
      c.env.AI_GATEWAY_TOKEN,
      c.env.AI_GATEWAY_BASE_URL,
      modelConfig,
    );

    // Helper to extract text from a message (handles both .content and .parts)
    const extractText = (msg: unknown): string => {
      if (!msg) return "";
      const m = msg as any;
      if (typeof m.content === "string" && m.content) return m.content;
      const parts = Array.isArray(m.parts)
        ? m.parts
        : Array.isArray(m.content)
          ? m.content
          : [];
      const textPart = parts.find((p: any) => p.type === "text");
      return textPart?.text ?? "";
    };

    // Derive a short title from the first user message for new sessions
    const firstUserMsg = messages.find((m) => m.role === "user");
    const firstText = extractText(firstUserMsg);
    const title =
      firstText.length > 60
        ? firstText.substring(0, 57) + "..."
        : firstText || "New chat";

    // For database persistence on this turn, we need the latest user message
    const latestUserMsg = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    const latestText = extractText(latestUserMsg);

    // Get or create session
    const session = await getOrCreateSession(
      supabase,
      user.id,
      sessionId ?? null,
      title,
      modelConfig.id,
    );

    // Sanitize messages: remove any orphaned tool-call parts that don't have
    // matching tool-result parts. This prevents MissingToolResultsError when
    // a previous stream errored mid-tool-call and the result was never saved.
    const sanitizedMessages = (
      messages as Array<{
        role: string;
        parts?: Array<{
          type: string;
          toolCallId?: string;
          [k: string]: unknown;
        }>;
        [k: string]: unknown;
      }>
    ).map((msg) => {
      if (msg.role !== "assistant" || !Array.isArray(msg.parts)) return msg;

      // Collect all tool-result IDs across all messages
      const resultIds = new Set<string>();
      for (const m of messages as Array<{
        parts?: Array<{ type: string; toolCallId?: string }>;
      }>) {
        if (!Array.isArray(m.parts)) continue;
        for (const p of m.parts) {
          if (p.type === "tool-result" && p.toolCallId) {
            resultIds.add(p.toolCallId);
          }
        }
      }

      // Filter out tool-call parts without matching results
      const filteredParts = msg.parts.filter((p) => {
        if (p.type === "tool-call" && p.toolCallId) {
          return resultIds.has(p.toolCallId);
        }
        return true;
      });

      return { ...msg, parts: filteredParts };
    });

    // Convert UI messages → model messages (AI SDK v6 async)
    const modelMessages = await convertToModelMessages(
      sanitizedMessages as Parameters<typeof convertToModelMessages>[0],
    );

    // Create tools — pass session.id so searchConversationDocument is scoped correctly
    const tools = createAllTools(supabase, c.env.AI, user.id, session.id, c.env);

    // Log the request being sent to the LLM
    const toolNames = Object.keys(tools);
    console.log("[handleStream] LLM Request:", {
      model: `${modelConfig.gatewayProvider}/${modelConfig.id}`,
      baseUrl: c.env.AI_GATEWAY_BASE_URL,
      toolCount: toolNames.length,
      tools: toolNames,
      messageCount: modelMessages.length,
      messages: modelMessages.map((m) => ({
        role: m.role,
        contentPreview:
          typeof m.content === "string"
            ? m.content.substring(0, 100)
            : "[complex content]",
      })),
    });

    // Stream response
    const result = streamText({
      model,
      system: (() => {
        let p = fullSystemPrompt;
        const pc = (body as any).pageContext;
        if (pc) {
          p += `\n\n[CURRENT PAGE CONTEXT]
The user is currently looking at the webpage: ${pc.url}

Below is the raw text scraped directly from their screen right now. You DO have access to this page because the text is provided to you right here. Do NOT claim you cannot scan or read the page. Use the provided text to answer questions about what they are looking at:

--- START OF SCREEN TEXT ---
${pc.content ? pc.content : "No text visible."}
--- END OF SCREEN TEXT ---`;
        }
        return p;
      })(),
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(12),
      temperature: 0.1,
      maxTokens: modelConfig.maxOutputTokens,
      // Repair tool calls where the LLM sends strings instead of numbers/booleans
      experimental_repairToolCall: async ({ toolCall, error }) => {
        try {
          const args = JSON.parse(toolCall.args);
          // Coerce string values that look like numbers or booleans
          for (const key of Object.keys(args)) {
            const val = args[key];
            if (typeof val === "string") {
              if (/^\d+$/.test(val)) {
                args[key] = parseInt(val, 10);
              } else if (/^\d+\.\d+$/.test(val)) {
                args[key] = parseFloat(val);
              } else if (val === "true" || val === "false") {
                args[key] = val === "true";
              }
            }
          }
          console.log(
            `[repairToolCall] Fixed args for ${toolCall.toolName}:`,
            args,
          );
          return { ...toolCall, args: JSON.stringify(args) };
        } catch {
          console.error(
            `[repairToolCall] Could not repair ${toolCall.toolName}:`,
            error,
          );
          return null;
        }
      },
      onFinish: async ({ text, steps }) => {
        // Persist after stream completes
        try {
          const toolsUsed = steps.flatMap((s) =>
            (s.toolCalls ?? []).map((tc) => tc.toolName),
          );
          await persistMessages(supabase, session.id, latestText, text, {
            model: modelConfig.id,
            toolsUsed,
            sessionId: session.id,
          });
        } catch (err) {
          console.error("[onFinish] Failed to persist messages:", err);
        }
      },
    });

    // Return session id in response headers so client can track it
    const response = result.toUIMessageStreamResponse();
    const headers = new Headers(response.headers);
    headers.set("X-Session-Id", session.id);
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    console.error("[handleStream] error:", error);
    return c.json(
      {
        error: "Stream failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
}

// ============================================
// POST /api/chatbot/upload-attachment
// ============================================

export async function handleUploadAttachment(
  c: Context<{ Bindings: CloudflareBindings }>,
) {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    const sessionId = formData.get("sessionId") as string | null;

    if (!file) return c.json({ error: "No file provided" }, 400);
    if (!sessionId) return c.json({ error: "sessionId required" }, 400);

    const user = c.get("user");
    const supabase = await getSupabaseAdminClient(c.env);

    const result = await uploadConversationDocument(
      supabase,
      c.env.AI,
      sessionId,
      user.id,
      file,
    );

    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("[handleUploadAttachment] error:", error);
    return c.json(
      {
        error: "Upload failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
}

/**
 * Upload and process PDF document — hybrid per-page pipeline.
 * POST /api/chatbot/documents/upload
 *
 * Each page is classified and routed:
 *   Path A (Prose): Selectable text, not table-heavy → accumulate → chunk → embed → finasaan_documents
 *   Path B (Table-heavy selectable): Table-heavy text → render page to PNG → vision LLM → tables + prose
 *   Path C (Scanned): Entire PDF < 200 non-whitespace chars → ALL pages via vision
 *
 * Fallback chain: render fails → text-only vision. Vision fails → treat as prose. Never crash.
 */
export async function handleUploadPDF(
  c: Context<{ Bindings: CloudflareBindings }>
) {
  try {
    // 1. Parse multipart form data
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    const company = formData.get("company") as string | null;
    const period = formData.get("period") as string | null;
    const docType = formData.get("doc_type") as string | null;
    const policyName = formData.get("policy_name") as string | null;
    const sourceName = formData.get("source_name") as string | null;
    const domain = (formData.get("domain") as string | null) || "financials";

    // 2. Validate
    if (!file) {
      return c.json({ error: "No PDF file provided" }, 400);
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return c.json({ error: "Only PDF files are allowed" }, 400);
    }
    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) {
      return c.json({ error: "File too large. Maximum size is 50MB" }, 400);
    }

    console.log(`[UploadPDF] Processing: ${file.name} (${file.size} bytes)`);

    // 3. Hash raw PDF bytes for deduplication
    const pdfBuffer = await file.arrayBuffer();
    const documentHash = await computeDocumentHash(pdfBuffer);

    // 4. Dedup check against finasaan_documents
    const supabase = await getSupabaseAdminClient(c.env);
    const alreadyExists = await finasaanDocumentExists(supabase, documentHash);
    if (alreadyExists) {
      return c.json({
        success: true,
        message: "Document already ingested (duplicate hash)",
        skipped: true,
        statistics: {
          filename: file.name,
          company: company || "Not specified",
          period: period || "Not specified",
          doc_type: docType || "Not specified",
          total_pages: 0,
          scanned: false,
          vision_pages_processed: 0,
          prose_chunks_stored: 0,
          tables_extracted: 0,
        },
      });
    }

    const aiGatewayToken = c.env.AI_GATEWAY_TOKEN;
    const ai = c.env.AI;
    const pdfData = new Uint8Array(pdfBuffer);

    // 5. Extract per-page texts (single PDF parse)
    const pageTexts = await extractPerPageTexts(pdfData);
    const totalPages = pageTexts.length;

    // Derive full text from per-page results to avoid parsing PDF twice
    const fullText = pageTexts.join("\n");
    const isScanned = countNonWhitespace(fullText) < 200;

    console.log(`[UploadPDF] Scanned: ${isScanned}, fullText chars: ${countNonWhitespace(fullText)}, pages: ${totalPages}`);

    // 7. Per-page hybrid classification loop
    // CF Workers free plan: 50 subrequests/invocation. Each vision call is 1 fetch().
    // Budget: 1 dedup + 1 table batch insert + 1 prose insert = 3 fixed. Leave 40 for vision.
    const MAX_VISION_PAGES = 40;
    const proseBuffer: string[] = [];
    const tablesToStore: any[] = [];
    let visionPagesProcessed = 0;
    let visionPagesAttempted = 0;
    let visionPagesCapped = 0;

    for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
      const pageText = pageTexts[pageIndex];
      const pageNumber = pageIndex + 1;
      const tableHeavy = isTableHeavyPage(pageText);

      console.log(
        `[UploadPDF] Page ${pageNumber}/${totalPages}: ` +
          `${pageText.length} chars, ` +
          `tableHeavy=${tableHeavy}, ` +
          `preview="${pageText.substring(0, 120).replace(/\n/g, " ")}..."`
      );

      if (isScanned || tableHeavy) {
        // --- Path B / Path C: Vision extraction ---

        // Guard: each vision call is one fetch() subrequest. Cap at MAX_VISION_PAGES
        // so we never exceed the CF Workers subrequest limit on large documents.
        if (visionPagesAttempted >= MAX_VISION_PAGES) {
          console.log(
            `[UploadPDF] Vision cap (${MAX_VISION_PAGES}) reached at page ${pageNumber}, accumulating as prose`
          );
          visionPagesCapped++;
          if (pageText.trim().length > 0) proseBuffer.push(pageText);
          continue;
        }
        visionPagesAttempted++;

        let base64PNG: string | null = null;
        try {
          base64PNG = await renderPageToBase64PNG(pdfData, pageNumber);
        } catch (renderErr) {
          console.warn(
            `[UploadPDF] renderPageToBase64PNG failed page ${pageNumber}, using text fallback:`,
            renderErr instanceof Error ? renderErr.message : renderErr
          );
        }

        let visionResult;
        try {
          visionResult = await extractPageViaVision(
            aiGatewayToken,
            base64PNG,
            {
              company_name: company || "Unknown",
              doc_type: docType || undefined,
              pageNumber,
              totalPages,
            },
            pageText // fallback text when base64PNG is null
          );
          visionPagesProcessed++;
        } catch (visionErr) {
          // Vision failed entirely — treat page as prose (fallback)
          console.warn(
            `[UploadPDF] Vision extraction failed page ${pageNumber}, treating as prose:`,
            visionErr instanceof Error ? visionErr.message : visionErr
          );
          if (pageText.trim().length > 0) {
            proseBuffer.push(pageText);
          }
          continue;
        }

        // Accumulate vision prose
        if (visionResult.prose.trim().length > 50) {
          proseBuffer.push(visionResult.prose);
        }

        // Collect valid tables for batch storage
        for (const table of visionResult.tables) {
          if (isVisionTableValid(table)) {
            const record = buildExtractedTableRecord(
              table,
              documentHash,
              company,
              docType
            );
            tablesToStore.push(record);
          } else {
            console.log(
              `[UploadPDF] Vision table invalid on page ${pageNumber}, skipping: ${table.table_name || "(unnamed)"}`
            );
          }
        }
      } else {
        // --- Path A: Prose page with selectable text ---
        if (pageText.trim().length > 0) {
          proseBuffer.push(pageText);
        }
      }
    }

    // 7.5 Bulk store extracted tables
    let extractedTableIds: string[] = [];
    if (tablesToStore.length > 0) {
      try {
        console.log(`[UploadPDF] Batch storing ${tablesToStore.length} tables...`);
        extractedTableIds = await storeExtractedTables(supabase, tablesToStore);
      } catch (storeErr) {
        console.error(
          `[UploadPDF] Bulk table storage failed:`,
          storeErr instanceof Error ? storeErr.message : storeErr
        );
      }
    }

    // 8. Chunk accumulated prose, embed, and store in finasaan_documents
    const allProseText = proseBuffer.join("\n\n");
    let storedCount = 0;

    if (allProseText.length > 0) {
      const chunks = chunkText(allProseText, company || undefined, period || undefined, {
        chunkSize: 1000,
        overlap: 200,
      });

      if (chunks.length > 0) {
        const texts = chunks.map((ch) => ch.text);

        // Batch embeddings in groups of 20 (Workers AI limit)
        const allEmbeddings: number[][] = [];
        const batchSize = 20;
        for (let i = 0; i < texts.length; i += batchSize) {
          const batch = texts.slice(i, i + batchSize);
          const batchEmbeddings = await generateEmbeddings(ai, batch);
          allEmbeddings.push(...batchEmbeddings);
        }

        const documents = chunks.map((chunk, i) => ({
          content: chunk.text,
          embedding: allEmbeddings[i],
          metadata: {
            ...chunk.metadata,
            company: company || undefined,
            period: period || undefined,
            doc_type: docType || undefined,
            policy_name: policyName || undefined,
            source_name: sourceName || undefined,
            filename: file.name,
          } as Record<string, unknown>,
        }));

        storedCount = await storeFinasaanDocuments(
          supabase,
          documents,
          documentHash,
          domain
        );
      }
    }

    console.log(
      `[UploadPDF] Done: ${storedCount} prose chunks stored, ` +
        `${extractedTableIds.length} tables extracted, ` +
        `${visionPagesProcessed} vision pages processed`
    );

    // 9. Return response with statistics
    return c.json({
      success: true,
      message: "PDF processed and ingested successfully",
      statistics: {
        filename: file.name,
        company: company || "Not specified",
        period: period || "Not specified",
        doc_type: docType || "Not specified",
        total_pages: totalPages,
        scanned: isScanned,
        vision_pages_processed: visionPagesProcessed,
        vision_pages_capped: visionPagesCapped,
        prose_chunks_stored: storedCount,
        tables_extracted: extractedTableIds.length,
      },
    });
  } catch (error) {
    console.error("[UploadPDF] Error:", error);
    return c.json(
      {
        success: false,
        error: "PDF processing failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
}

// ============================================
// GET /api/chatbot/models
// ============================================

export async function handleGetModels(
  c: Context<{ Bindings: CloudflareBindings }>,
) {
  const models = MODELS.filter((m) => m.isEnabled).map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    isPro: m.isPro,
    supportsToolCalling: m.supportsToolCalling,
  }));

  return c.json({ models, default: DEFAULT_MODEL_ID });
}

// ============================================
// GET /api/chatbot/sessions
// ============================================

export async function handleGetSessions(
  c: Context<{ Bindings: CloudflareBindings }>,
) {
  try {
    const user = c.get("user");
    const supabase = await getSupabaseAdminClient(c.env);
    const sessions = await getUserSessions(supabase, user.id);
    return c.json({ sessions, count: sessions.length });
  } catch (error) {
    console.error("[handleGetSessions] error:", error);
    return c.json({ error: "Failed to get sessions" }, 500);
  }
}

// ============================================
// GET /api/chatbot/sessions/:id
// ============================================

export async function handleGetSession(
  c: Context<{ Bindings: CloudflareBindings }>,
) {
  try {
    const sessionId = c.req.param("id");
    const user = c.get("user");
    const supabase = await getSupabaseAdminClient(c.env);

    const result = await getSessionMessages(supabase, sessionId, user.id);
    if (!result) return c.json({ error: "Session not found" }, 404);

    return c.json(result);
  } catch (error) {
    console.error("[handleGetSession] error:", error);
    return c.json({ error: "Failed to get session" }, 500);
  }
}

// ============================================
// DELETE /api/chatbot/sessions/:id
// ============================================

export async function handleDeleteSession(
  c: Context<{ Bindings: CloudflareBindings }>,
) {
  try {
    const sessionId = c.req.param("id");
    const user = c.get("user");
    const supabase = await getSupabaseAdminClient(c.env);

    await deleteSession(supabase, sessionId, user.id);
    return c.json({ success: true });
  } catch (error) {
    console.error("[handleDeleteSession] error:", error);
    return c.json({ error: "Failed to delete session" }, 500);
  }
}
