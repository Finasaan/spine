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
    /** Max context window (input + output) on Groq free tier */
    maxTokens: 131072,
  },
  "llama-3.3-70b-versatile": {
    id: "llama-3.3-70b-versatile",
    name: "Llama 3.3 70B Versatile",
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

/**
 * Get the token limit for a given model
 * Falls back to a conservative 8000 if unknown
 */
export function getModelTokenLimit(model: GroqModelId): number {
  return GROQ_MODELS[model]?.maxTokens ?? 8000;
}

// ============================================
// Token Budget Utilities
// ============================================

/** Rough token estimate: ~4 chars per token for English text */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build a token-budgeted payload for the LLM.
 *
 * Priority order (highest to lowest):
 *   1. System prompt (always included)
 *   2. User query (always included)
 *   3. RAG context chunks (in relevance/similarity order — highest first)
 *   4. Chat history (most recent first)
 *
 * Returns the assembled messages array and a safe max_tokens value.
 */
export function buildBudgetedMessages(opts: {
  systemPromptTemplate: string;
  contextChunks: string[];
  history: Array<{ role: string; content: string }>;
  userQuery: string;
  model: GroqModelId;
}): { messages: Array<{ role: string; content: string }>; maxResponseTokens: number } {
  const modelLimit = getModelTokenLimit(opts.model);

  // Reserve tokens for overhead (JSON framing, role tokens, etc.)
  const OVERHEAD_BUFFER = 200;

  // Cap response tokens: at most 2048 or 30% of budget, whichever is smaller
  const maxResponseCap = Math.min(2048, Math.floor(modelLimit * 0.3));

  // --- 1. User query is always included ---
  const queryTokens = estimateTokens(opts.userQuery);

  // --- 2. Figure out how many context chunks fit ---
  // Start with the system prompt *without* context to get its base cost
  const basePrompt = opts.systemPromptTemplate.replace("{context}", "");
  const basePromptTokens = estimateTokens(basePrompt);

  // Budget available for context + history + response
  let remainingBudget = modelLimit - basePromptTokens - queryTokens - OVERHEAD_BUFFER;

  // Reserve response tokens first
  const responseTokens = Math.min(maxResponseCap, Math.max(512, Math.floor(remainingBudget * 0.35)));
  remainingBudget -= responseTokens;

  // Fill context chunks in order (they're already sorted by relevance)
  const includedChunks: string[] = [];
  for (const chunk of opts.contextChunks) {
    const chunkTokens = estimateTokens(chunk);
    if (chunkTokens <= remainingBudget) {
      includedChunks.push(chunk);
      remainingBudget -= chunkTokens;
    }
    // If a chunk doesn't fit, skip it and try the next (smaller ones may fit)
  }

  // Build the system prompt with the included context
  const contextStr = includedChunks.length > 0
    ? includedChunks.join("\n\n---\n\n")
    : "No relevant context found.";
  const systemPrompt = opts.systemPromptTemplate.replace("{context}", contextStr);

  // --- 3. Fill history with remaining budget (most recent first) ---
  const includedHistory: Array<{ role: string; content: string }> = [];
  const reversedHistory = [...opts.history].reverse();
  for (const msg of reversedHistory) {
    const msgTokens = estimateTokens(msg.content) + 4; // +4 for role/framing
    if (msgTokens <= remainingBudget) {
      includedHistory.unshift(msg); // prepend to maintain chronological order
      remainingBudget -= msgTokens;
    } else {
      break; // stop once a message doesn't fit (history is contiguous)
    }
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...includedHistory,
    { role: "user", content: opts.userQuery },
  ];

  return { messages, maxResponseTokens: responseTokens };
}

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

/** Query domain: which knowledge base to search */
export type ChatDomain = "insurance" | "stocks" | "auto";

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
  /** Which knowledge base to search: "insurance", "stocks", or "auto" (default) */
  domain?: ChatDomain;
}

export interface ChatResponse {
  chat_id: string;
  answer: string;
  sources: ChatSource[];
  metadata: {
    chunks_retrieved: number;
    model: string;
    domain: ChatDomain;
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
// Domain Detection
// ============================================

/**
 * Keywords that indicate an insurance-related query
 */
const INSURANCE_KEYWORDS = [
  // General insurance terms
  "insurance",
  "insurer",
  "insured",
  "policy",
  "premium",
  "claim",
  "coverage",
  "exclusion",
  "deductible",
  "beneficiary",
  "underwriting",
  "indemnity",
  "liability",
  "assured",
  "policyholder",
  "sum assured",
  "rider",
  "endowment",
  // Islamic/Takaful terms
  "takaful",
  "wakeel",
  "surplus",
  "riba",
  "gharar",
  "maysir",
  "ta'awun",
  "shariah",
  "sharia",
  // Product categories
  "health plan",
  "health insurance",
  "motor insurance",
  "car insurance",
  "fire insurance",
  "marine insurance",
  "travel insurance",
  "life insurance",
  "cyber insurance",
  "property insurance",
  "engineering insurance",
  // Pakistani companies
  "adamjee",
  "jubilee life",
  "jubilee insurance",
  "efu life",
  "efu",
  "state life",
  "chubb",
  "alfalah insurance",
  "pak-qatar",
  "pak qatar",
  "tpl life",
  "tpl insurance",
];

/**
 * Detect whether a query is about insurance or stocks
 * Returns "insurance" if insurance keywords found, "stocks" otherwise
 */
export function detectQueryDomain(query: string): "insurance" | "stocks" {
  const lower = query.toLowerCase();
  const isInsurance = INSURANCE_KEYWORDS.some((kw) => lower.includes(kw));
  return isInsurance ? "insurance" : "stocks";
}

// ============================================
// System Prompts
// ============================================

/**
 * System prompt for stock/financial document queries
 */
export const STOCKS_SYSTEM_PROMPT = `You are finasaanGPT, a Pakistani financial literacy assistant. You are currently answering questions about company financial reports, including financial statements, cash flow, and management discussion from the Pakistan Stock Exchange (PSX).

Key Guidelines:
1. Always prioritize accuracy and refer to the retrieved context provided below
2. If data is numerical, summarize it clearly with proper formatting (use PKR for Pakistani Rupees)
3. If the answer is not present in the retrieved documents, explicitly state: "I cannot find this information in the provided documents"
4. When citing financial figures, include the reporting period if available
5. Be concise but comprehensive in your responses
6. If asked about trends, compare data across periods when available
7. Always maintain a professional, factual tone
8. Frame responses in a way that helps users learn about financial concepts

Retrieved Context:
{context}

Based on the above context, please answer the following question:`;

/**
 * System prompt for insurance-related queries
 */
export const INSURANCE_SYSTEM_PROMPT = `You are finasaanGPT, a Pakistani financial literacy assistant. You are currently answering questions about insurance products, policies, and coverage details from Pakistani insurance and Takaful companies.

Key Guidelines:
1. Always prioritize accuracy and refer to the retrieved insurance documents below
2. Clearly distinguish between conventional insurance and Takaful (Islamic insurance) when relevant
3. When discussing coverage, always mention key exclusions if available — users need to know what is NOT covered
4. If the answer is not present in the retrieved documents, explicitly state: "I cannot find this information in the provided insurance documents. I recommend checking directly with the insurance company."
5. Use simple, accessible language — many users are learning about insurance for the first time
6. When mentioning specific products, include the company name
7. If a query involves medical/health insurance, remind users that policy terms may vary and to verify with the insurer
8. Always maintain a professional, educational tone
9. Frame responses to help users understand insurance concepts, not just answer the question
10. When comparing products, present information objectively without recommending specific companies

Retrieved Insurance Context:
{context}

Based on the above context, please answer the following question:`;

/**
 * Legacy system prompt — kept for backwards compatibility
 * The chatbot controller now uses STOCKS_SYSTEM_PROMPT and INSURANCE_SYSTEM_PROMPT
 */
export const SYSTEM_PROMPT = STOCKS_SYSTEM_PROMPT;
