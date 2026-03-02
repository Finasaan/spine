/**
 * Chatbot Controller — FinasaanGPT v2
 * Streaming AI responses via AI SDK v6 + Cloudflare AI Gateway.
 */

import { Context } from "hono";
import { streamText, stepCountIs, convertToModelMessages } from "ai";
import { getSupabaseClient } from "../db";
import { createModel } from "../services/ai.service";
import { createAllTools } from "../services/tools";
import {
  getOrCreateSession,
  persistMessages,
  getUserSessions,
  getSessionMessages,
  deleteSession,
  uploadConversationDocument,
} from "../services/chatbot.service";
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
- Do not provide specific buy/sell recommendations — present data and let users decide.
- For PSX stocks: always include ticker symbol, price, and % change when available.
- For mutual funds: always mention NAV, fund category, and management company.
- For insurance: always reference the specific policy/company from the knowledge base.
- Cite your sources at the end of data-heavy responses.

Tool usage strategy:
- For "best performing", "top", or ranking questions: use queryMutualFunds or getTopStocks with appropriate sortBy and sortOrder desc.
- For period-based returns (e.g. "best fund over 5 years"): use queryMutualFunds with sortBy='return' and returnPeriodMonths (12=1yr, 36=3yr, 60=5yr).
- For category-specific queries (equity funds, money market, Islamic): use the category filter on queryMutualFunds.
- For provider/AMC-specific queries (e.g. "HBL funds"): first call getFundProviders, then queryMutualFunds with providerId.
- For sector-specific stock queries (banking stocks, cement sector): first call listSectors to find the sector ID, then use getTopStocks or searchCompanies with sectorId.
- For performance trends or historical analysis: use getFundNavHistory (up to 5 years) or getStockHistory (up to 5 years).
- For insurance, financial literacy, or general knowledge questions: use searchKnowledge with the appropriate domain filter.
- Chain multiple tools when needed — e.g., queryMutualFunds to find funds, then getFundNavHistory for detailed performance.
- For comparison questions: retrieve data for all items being compared, then present in a markdown table.
- Always try to answer the query using available tools. Only say you cannot if no combination of tools can produce the answer.

Today's date: ${new Date().toLocaleDateString("en-PK", { timeZone: "Asia/Karachi" })}`;

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
    const supabase = await getSupabaseClient(c.env);
    const modelConfig = resolveModel(modelId);
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

    // Create tools
    const tools = createAllTools(supabase, c.env.AI, user.id);

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
      system: SYSTEM_PROMPT,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(8),
      temperature: 0.7,
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
    const supabase = await getSupabaseClient(c.env);

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
    const supabase = await getSupabaseClient(c.env);
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
    const supabase = await getSupabaseClient(c.env);

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
    const supabase = await getSupabaseClient(c.env);

    await deleteSession(supabase, sessionId, user.id);
    return c.json({ success: true });
  } catch (error) {
    console.error("[handleDeleteSession] error:", error);
    return c.json({ error: "Failed to delete session" }, 500);
  }
}
