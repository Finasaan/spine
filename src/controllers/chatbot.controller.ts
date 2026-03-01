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
const DEFAULT_MODEL_ID = "llama-3.1-8b-instant";

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

    // Derive a short title from the first user message for new sessions
    const firstUserMsg = messages.find((m) => m.role === "user");
    const rawContent = firstUserMsg?.content;
    const firstText =
      typeof rawContent === "string"
        ? rawContent
        : Array.isArray(rawContent)
          ? ((
              rawContent.find(
                (p: unknown) => (p as { type: string }).type === "text",
              ) as { text: string } | undefined
            )?.text ?? "")
          : "";
    const title =
      firstText.length > 60
        ? firstText.substring(0, 57) + "..."
        : firstText || "New chat";

    // Get or create session
    const session = await getOrCreateSession(
      supabase,
      user.id,
      sessionId ?? null,
      title,
      modelConfig.id,
    );

    // Convert UI messages → model messages (AI SDK v6 async)
    const modelMessages = await convertToModelMessages(
      messages as Parameters<typeof convertToModelMessages>[0],
    );

    // Create tools
    const tools = createAllTools(supabase, c.env.AI, user.id);

    // Stream response
    const result = streamText({
      model,
      system: SYSTEM_PROMPT,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(8),
      temperature: 0.7,
      maxTokens: modelConfig.maxOutputTokens,
      onFinish: async ({ text, steps }) => {
        // Persist after stream completes
        try {
          const toolsUsed = steps.flatMap((s) =>
            (s.toolCalls ?? []).map((tc) => tc.toolName),
          );
          await persistMessages(supabase, session.id, firstText, text, {
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
