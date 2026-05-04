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

DOMAIN GUARDRAILS:
- You are strictly assigned to the domain of Pakistan stocks, mutual funds, insurance, taxation, and the user's portfolio.
- NEVER do anything outside of your assigned domain. If a user asks something outside this domain, explicitly drop a simple rejection message (e.g., "I can only assist with finance, investments, taxation, and portfolio matters.").
- Your first resort should ALWAYS be your tool calls for data. Only add onto that with your own base knowledge after retrieving and analyzing the data.
- DO NOT make up data or hallucinate prices/statistics. If you don't know something or cannot find it via tools, say so explicitly.
- You ARE allowed to provide financial advice, valuations, and stock picks based on your analysis. However, whenever you do, you must always drop a disclaimer at the end: "⚠️ Not investment advice. Always do your own research before acting."

Rules:
- Keep responses dense and structured. Use markdown tables for comparisons.
- Answer investment-related questions thoroughly using all available data and tools.
- For valuation and analysis questions: NEVER refuse because a pre-calculated metric (P/E, EPS, P/B, dividend yield, etc.) isn't directly in the database. Instead, retrieve the raw components using your tools and CALCULATE these metrics yourself. For example: P/E = current stock price ÷ earnings per share; EPS = net profit ÷ shares outstanding; P/B = market cap ÷ book value. If data is partial, work with what you have, state your assumptions clearly, and present your best-effort analysis rather than giving up. An approximate answer with caveats is always better than no answer.
- For PSX stocks: always include ticker symbol, price, and % change when available.
- For mutual funds: always mention NAV, fund category, and management company.
- For insurance: always reference the specific policy/company from the knowledge base.
- For taxation: use searchTaxDocs to query Pakistan tax laws, ordinances, and FBR circulars.
- Cite your sources at the end of data-heavy responses.

Tool usage strategy:

[DOCUMENTS & KNOWLEDGE]
- searchConversationDocument: ALWAYS call FIRST when the user references an uploaded file/document or asks "what does this document say".
- searchKnowledge: For qualitative content (management commentary, report notes, insurance policy details, financial literacy). Pass domain ('financials', 'insurance', etc.) and optionally company/period filters. AUTO-RESOLVES company name variations — just pass whatever the user said. Example: searchKnowledge({query: "operating profit commentary", domain: "financials", company: "PTCL", period: "Q1 2026"}).
- searchTaxDocs: ALWAYS use for ANY taxation question (slabs, FBR circulars, ordinances, rules, exemptions, tax filing).

[FINANCIAL STATEMENTS & NUMBERS]
- queryFinancialTables: ALWAYS use FIRST for specific financial figures (revenue, profit, assets, equity, EPS, cash flows, balance sheet, income statement). AUTO-RESOLVES company names — just pass user input. If response has a fallbackResults array, those are real ingested-document chunks — read and quote from them. Only conclude "no data" if BOTH tables AND fallbackResults are empty.
- If queryFinancialTables comes up empty, chain to searchKnowledge with the same company/period as a final attempt before giving up.

[PSX STOCKS & COMPANIES]
- getMarketSummary: Use for KSE-100, KSE-30, market overview, daily index change, total market volume questions.
- searchCompanies: Use to find a ticker by company name, browse companies, or filter by sector. CALL THIS FIRST whenever you don't know the exact PSX ticker — NEVER guess or invent tickers. Example: user says "Meezan Bank" → searchCompanies({query: "Meezan"}) → returns symbol "MEBL".
- getStockDetail: Latest price, sector, description for one stock. Pass the PSX ticker. Will fuzzy-match a company name as a fallback, but exact tickers are more reliable.
- getStockHistory: Daily price history for trend analysis (up to 5 years / 1825 days). Pass the PSX ticker.
- getTopStocks: Top performers or most active stocks. sortBy = 'value_traded' | 'volume' | 'close_price'. Optional sectorId filter.
- listSectors: List all PSX sectors with IDs. Call this BEFORE filtering by sector in getTopStocks or searchCompanies.
- RECOVERY RULE: If getStockDetail or getStockHistory returns "not found", IMMEDIATELY call searchCompanies with the user's original phrase to find the correct ticker, then retry. Do NOT give up after one failure.

[MUTUAL FUNDS]
- queryMutualFunds: Search/filter funds by category, risk, returns. For "best fund over X years" use sortBy='return' with returnPeriodMonths (12=1yr, 36=3yr, 60=5yr). For category questions (equity, money market, Islamic) use the category filter.
- getFundDetail: Full details on a specific fund — use when the user asks about one named fund.
- getFundNavHistory: NAV price history (up to 5 years) for fund performance trends.
- getFundProviders: List all AMCs / fund management companies. Call FIRST for provider-specific queries — example: "HBL funds" → getFundProviders → queryMutualFunds({providerId}).

[USER-SPECIFIC — authenticated]
- getUserPortfolio: User's portfolios and holdings. Use for "my portfolio", "what stocks do I own", "show my investments", "my holdings".
- getUserWatchlist: User's saved stocks/funds. Use for "my watchlist", "saved stocks", "what am I tracking".
- getPortfolioInsight: AI-generated portfolio health summary (P/L analysis, news impact on holdings). Use for "analyze my portfolio", "how am I doing", "portfolio health".

[NEWS & EVENTS]
- getRecentHeadlines: Broad view of recent Pakistan economic/business news, optionally filtered by sentiment.
- searchRecentNews: Semantic search of news for topic-specific retrieval.
- For "what's happening" questions, call getRecentHeadlines first, then searchRecentNews to drill in. Always cite source name and publication date.

[WEB SEARCH — LAST RESORT]
- webSearch: Call ONLY after all relevant internal tools have returned insufficient data. Good for: live P/E ratios not in DB, recent quarterly results not yet indexed, current index levels, Pakistan macro data, latest news Finasaan hasn't ingested. Set recency='day' or 'week' for live market data, 'month' for recent earnings. ALWAYS cite the source URL and note the data is from the web (not Finasaan's verified database).

[CHAINING & PRINCIPLES]
- For valuation questions (P/E, P/B, fair value, "is X overvalued"): (1) searchCompanies to resolve ticker if unsure; (2) getStockDetail for current price; (3) queryFinancialTables for net profit, equity, shares outstanding, revenue, EPS; (4) calculate P/E = price ÷ EPS, P/B = market cap ÷ book value yourself; (5) compare to sector or historical multiples. Show your derivation.
- For comparison questions: gather data for all items, then present in a markdown table.
- For sector-wide questions: listSectors → getTopStocks(sectorId) or searchCompanies(sectorId).
- Always try internal tools first. Only fall back to webSearch when internal sources are exhausted. Only say "I cannot find this" if NO combination of tools (including webSearch) produces an answer.
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

    // Sanitize messages: drop any tool parts from previous assistant turns
    // that never produced a result. AI SDK v6 represents tool invocations as
    // `tool-{name}` or `dynamic-tool` parts with a `state` field. If a prior
    // stream errored mid-tool-call, those parts get persisted in `state:
    // 'input-streaming'` or `'input-available'` (no output) — feeding them
    // back into the next request triggers MissingToolResultsError on the
    // provider side, which is one of the main causes of repeat stream
    // failures we see on Groq Llama.
    const sanitizedMessages = (
      messages as Array<{
        role: string;
        parts?: Array<{ type: string; state?: string; [k: string]: unknown }>;
        [k: string]: unknown;
      }>
    )
      .map((msg) => {
        if (msg.role !== "assistant" || !Array.isArray(msg.parts)) return msg;

        const filteredParts = msg.parts.filter((p) => {
          const isToolPart =
            p.type === "dynamic-tool" || p.type.startsWith("tool-");
          if (!isToolPart) return true;
          // Keep only tool parts that reached a terminal state.
          return p.state === "output-available" || p.state === "output-error";
        });

        return { ...msg, parts: filteredParts };
      })
      // Drop assistant turns that became empty after sanitization. An
      // assistant message with no parts gets converted to an empty content
      // array, which Groq rejects as a malformed message in the next turn.
      .filter((msg) => {
        if (msg.role !== "assistant") return true;
        if (!Array.isArray(msg.parts)) return true;
        return msg.parts.length > 0;
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

    // Track partial assistant output so we can persist it even if the stream
    // errors mid-flight (e.g. Groq drops the connection after a tool call).
    let partialText = "";
    let persisted = false;
    const flushPersist = async (
      text: string,
      toolsUsed: string[],
      errorMessage?: string,
    ) => {
      if (persisted) return;
      persisted = true;
      try {
        await persistMessages(supabase, session.id, latestText, text, {
          model: modelConfig.id,
          toolsUsed,
          sessionId: session.id,
          ...(errorMessage ? { error: errorMessage } : {}),
        });
      } catch (err) {
        console.error("[handleStream] Failed to persist messages:", err);
      }
    };

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
      maxOutputTokens: modelConfig.maxOutputTokens,
      // Repair tool calls where the LLM sends strings instead of numbers/booleans.
      // AI SDK v6: `toolCall.input` is the stringified JSON arg payload.
      experimental_repairToolCall: async ({ toolCall, error }) => {
        try {
          const args = JSON.parse(toolCall.input);
          for (const key of Object.keys(args)) {
            const val = args[key];
            if (typeof val === "string") {
              if (/^-?\d+$/.test(val)) {
                args[key] = parseInt(val, 10);
              } else if (/^-?\d+\.\d+$/.test(val)) {
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
          return { ...toolCall, input: JSON.stringify(args) };
        } catch {
          console.error(
            `[repairToolCall] Could not repair ${toolCall.toolName}:`,
            error,
          );
          return null;
        }
      },
      // Mirror text deltas so we can persist whatever the model managed to
      // produce even if the stream errors before onFinish fires.
      onChunk: ({ chunk }) => {
        if (chunk.type === "text-delta") {
          partialText += (chunk as { text?: string }).text ?? "";
        }
      },
      onError: ({ error }) => {
        console.error(
          "[handleStream] streamText error:",
          error instanceof Error ? error.stack ?? error.message : error,
        );
      },
      onFinish: async ({ text, steps }) => {
        const toolsUsed = steps.flatMap((s) =>
          (s.toolCalls ?? []).map((tc) => tc.toolName),
        );
        await flushPersist(text || partialText, toolsUsed);
      },
    });

    // Return session id in response headers so client can track it
    const response = result.toUIMessageStreamResponse({
      // Surface real error messages to the client. Without this, AI SDK's
      // default emits a generic 'An error occurred.' which makes Groq stream
      // failures impossible to debug from the UI.
      onError: (error) => {
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Stream failed. Please try again.";
        // Persist the user message + whatever partial content we got so the
        // turn isn't lost (the user sees their question vanish on reload
        // otherwise).
        c.executionCtx?.waitUntil?.(
          flushPersist(partialText, [], message).catch(() => {}),
        );
        return message;
      },
    });
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
