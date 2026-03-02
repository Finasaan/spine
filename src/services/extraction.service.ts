/**
 * Extraction Service
 * LLM-powered table structuring and vision-based page extraction.
 *
 * Two extraction paths:
 * 1. Text-based: raw table text → Llama 3.3 70B → structured JSON
 *    (used by marrow insurance pipeline via /api/extract/structure-table)
 * 2. Vision-based: page image → Llama 3.2 11B Vision → structured tables + prose
 *    (used by spine's handleUploadPDF for table-heavy and scanned pages)
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { AI_GATEWAY_CONFIG } from "../types/chatbot.types";

// ============================================================================
// Types — Text-Based Extraction (existing)
// ============================================================================

/** Metadata provided alongside a raw table for structuring */
export interface TableExtractionRequest {
  raw_table_text: string;
  source_document_id: string;
  source_type: string;
  company_id: string;
  company_name: string;
  policy_name?: string;
  doc_type?: string;
}

/** Structured output from the text-based LLM */
export interface StructuredTable {
  table_name: string;
  table_type: string;
  fiscal_period: string | null;
  currency: string | null;
  headers: string[];
  rows: Record<string, unknown>[];
}

// ============================================================================
// Types — Vision-Based Extraction (new)
// ============================================================================

/** Result from a single page processed by the vision model */
export interface VisionPageResult {
  prose: string;
  tables: VisionStructuredTable[];
}

/** A single table extracted by the vision model */
export interface VisionStructuredTable {
  table_name: string;
  table_type: string;
  fiscal_period: string | null;
  fiscal_period_end: string | null;
  currency: string | null;
  table_unit: string | null;
  comparative: boolean;
  headers: string[];
  rows: Record<string, unknown>[];
}

// ============================================================================
// Types — Storage Record (supports both paths)
// ============================================================================

/** Full record ready for Supabase insert */
export interface ExtractedTableRecord {
  source_document_id: string;
  source_type: string;
  company_id: string;
  company_name: string;
  table_name: string;
  table_type: string;
  fiscal_period: string | null;
  fiscal_period_end: string | null;
  currency: string | null;
  table_unit: string | null;
  comparative: boolean;
  headers: string[];
  rows: Record<string, unknown>[];
  raw_table_text: string;
  extraction_model: string;
}

// ============================================================================
// Constants
// ============================================================================

const EXTRACTION_MODEL = "llama-3.3-70b-versatile";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

/**
 * System prompt for text-based table structuring (insurance pipeline).
 */
const TABLE_STRUCTURING_PROMPT = `You are a data extraction assistant. Your job is to convert raw table text extracted from PDF documents into clean, structured JSON.

The input will be a raw table in one of these formats:
- Pipe-delimited (columns separated by |)
- Tab-delimited (columns separated by tabs)
- Space-aligned columns
- Markdown tables
- Mixed/messy formatting from PDF extraction

You MUST return a single JSON object with this exact schema:
{
  "table_name": "A short descriptive name for the table (e.g., 'Premium Schedule', 'Coverage Limits', 'Claim Settlement')",
  "table_type": "One of: 'premium_schedule', 'coverage_table', 'benefits_table', 'exclusions_list', 'financial_statement', 'rate_table', 'provider_list', 'claims_data', 'comparison_table', 'general'",
  "fiscal_period": "The fiscal period if mentioned (e.g., '2024', 'Q3 2024', 'FY2023-24'), or null if not applicable",
  "currency": "The currency if financial figures are present (e.g., 'PKR', 'USD'), or null if not applicable",
  "headers": ["Array", "of", "column", "header", "strings"],
  "rows": [
    {"header1": "value1", "header2": "value2"},
    {"header1": "value3", "header2": "value4"}
  ]
}

Rules:
1. ALWAYS return valid JSON — no markdown fencing, no explanations, just the JSON object
2. Clean up header names: remove extra whitespace, standardize casing (Title Case)
3. For numeric values: remove commas from numbers and store as numbers where possible (e.g., "1,234,567" → 1234567)
4. For percentage values: store as strings with the % sign (e.g., "15%")
5. For empty/missing cells: use null
6. If a row is clearly a sub-header or section divider, skip it (do not include it as a data row)
7. If the table has separator rows (like "---" or "==="), skip them
8. Infer table_type from the content — use "general" only as a last resort
9. Keep the original data intact — do not invent or hallucinate values
10. If the table has merged cells or spanning headers, flatten them into the most logical column structure`;

/**
 * System prompt for vision-based page extraction (financial document pipeline).
 */
const VISION_SYSTEM_PROMPT = `You are a financial document data extraction assistant. You will be given an image of a single page from a Pakistani company's financial document. This may be a rendered selectable-text PDF page or a fully scanned document.

Your task:
1. Extract and normalize ALL tables on this page into structured JSON.
2. Extract all non-table prose text (paragraphs, headings, footnotes, notes) as plain text.

CRITICAL RULES:
- Return ONLY a valid JSON object — no markdown fencing, no explanation, no code blocks
- Every numeric value must be a number, not a string (remove commas and currency symbols)
- Negative values: amounts shown as (1,234) or 1,234- must be stored as -1234
- Empty cells, dashes, or "—" → null
- If no tables on this page: "tables" must be []
- If no prose text: "prose" must be ""
- Fiscal period in ISO format: "YYYY", "YYYY-MM", or "YYYY-MM-DD"

NORMALIZATION — map row labels to canonical snake_case keys:
revenue, cost_of_sales, gross_profit, operating_profit, profit_before_tax,
profit_after_tax, eps, total_assets, total_liabilities, total_equity,
cash_and_equivalents, total_debt, operating_cash_flow, dividend_per_share,
nav_per_share, net_premium, claims_incurred, underwriting_result,
management_expenses, investment_income
For anything not in this list: convert the original label to lowercase_snake_case.

OUTPUT SCHEMA — return exactly this structure:
{
  "prose": "All non-table text on this page as plain paragraphs. Empty string if none.",
  "tables": [
    {
      "table_name": "Short descriptive name e.g. 'Income Statement', 'Balance Sheet'",
      "table_type": "One of: income_statement | balance_sheet | cash_flow | key_metrics | segment_data | fund_portfolio | premium_schedule | coverage_table | rate_table | general",
      "fiscal_period": "ISO period string or null",
      "fiscal_period_end": "ISO date YYYY-MM-DD or null",
      "currency": "PKR | USD | EUR | null",
      "table_unit": "PKR thousands | PKR millions | PKR billions | PKR | null",
      "comparative": true,
      "headers": ["label", "2024", "2023"],
      "rows": [
        {
          "label": "Original row label exactly as it appears in the document",
          "canonical_key": "snake_case_canonical_key or null if unclear",
          "2024": 1234567,
          "2023": 987654
        }
      ]
    }
  ]
}`;

// ============================================================================
// Text-Based LLM Call (existing — used by insurance pipeline)
// ============================================================================

/**
 * Call Groq via AI Gateway to structure a raw table into JSON.
 * Uses response_format: json_object for guaranteed valid JSON output.
 */
export async function structureTable(
  aiGatewayToken: string,
  rawTableText: string,
  context: {
    company_name: string;
    policy_name?: string;
    doc_type?: string;
  }
): Promise<StructuredTable> {
  const userMessage = [
    `Company: ${context.company_name}`,
    context.policy_name ? `Document: ${context.policy_name}` : null,
    context.doc_type ? `Document type: ${context.doc_type}` : null,
    "",
    "Raw table text:",
    "```",
    rawTableText,
    "```",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch(
    `${AI_GATEWAY_CONFIG.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${aiGatewayToken}`,
      },
      body: JSON.stringify({
        model: `groq/${EXTRACTION_MODEL}`,
        messages: [
          { role: "system", content: TABLE_STRUCTURING_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 4096,
        response_format: { type: "json_object" },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `AI Gateway error during table extraction: ${response.status} - ${errorText}`
    );
  }

  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (result.error) {
    throw new Error(`Groq error during table extraction: ${result.error.message}`);
  }

  const content = result.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("No response from LLM during table extraction");
  }

  const parsed = JSON.parse(content) as StructuredTable;

  if (!parsed.table_name || !parsed.table_type || !Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) {
    throw new Error(
      `LLM returned invalid table structure: missing required fields (got keys: ${Object.keys(parsed).join(", ")})`
    );
  }

  return parsed;
}

// ============================================================================
// Vision-Based Page Extraction (new — used by financial document pipeline)
// ============================================================================

/**
 * Extract tables and prose from a single PDF page via the vision model.
 *
 * @param aiGatewayToken - AI Gateway auth token
 * @param base64PNG - Base64-encoded PNG of the page, or null for text-only fallback
 * @param context - Page metadata for the user message
 * @param fallbackText - Raw text of the page (used when base64PNG is null)
 * @returns Parsed vision result with prose and tables
 */
export async function extractPageViaVision(
  aiGatewayToken: string,
  base64PNG: string | null,
  context: {
    company_name: string;
    doc_type?: string;
    pageNumber: number;
    totalPages: number;
  },
  fallbackText?: string
): Promise<VisionPageResult> {
  const userText = [
    `Company: ${context.company_name}`,
    context.doc_type ? `Document type: ${context.doc_type}` : null,
    `Page: ${context.pageNumber} of ${context.totalPages}`,
    "",
    "Extract all tables and prose from this page.",
  ]
    .filter(Boolean)
    .join("\n");

  // Build user message content — image + text, or text-only fallback
  let userContent: unknown;
  if (base64PNG) {
    userContent = [
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${base64PNG}` },
      },
      { type: "text", text: userText },
    ];
  } else {
    // Text-only fallback: include the raw page text inline
    const textFallback = fallbackText
      ? `\n\nPage text (extracted, no image available):\n${fallbackText}`
      : "";
    userContent = userText + textFallback;
  }

  const response = await fetch(
    `${AI_GATEWAY_CONFIG.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${aiGatewayToken}`,
      },
      body: JSON.stringify({
        model: `groq/${VISION_MODEL}`,
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 3500,
        response_format: { type: "json_object" },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `AI Gateway error during vision extraction: ${response.status} - ${errorText}`
    );
  }

  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (result.error) {
    throw new Error(`Groq error during vision extraction: ${result.error.message}`);
  }

  const content = result.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("No response from vision model");
  }

  const parsed = JSON.parse(content) as VisionPageResult;

  // Normalize: ensure prose is a string and tables is an array
  return {
    prose: typeof parsed.prose === "string" ? parsed.prose : "",
    tables: Array.isArray(parsed.tables) ? parsed.tables : [],
  };
}

// ============================================================================
// Vision Table Validation
// ============================================================================

/**
 * Validate a vision-extracted table before storage.
 * Must have name, type, headers, at least one row with a non-null numeric value.
 */
export function isVisionTableValid(table: VisionStructuredTable): boolean {
  if (!table.table_name || !table.table_type) return false;
  if (!Array.isArray(table.headers) || table.headers.length === 0) return false;
  if (!Array.isArray(table.rows) || table.rows.length === 0) return false;

  // At least one row must have a non-null numeric value
  const hasNumeric = table.rows.some((row) =>
    Object.values(row).some((v) => typeof v === "number" && v !== 0)
  );
  return hasNumeric;
}

/**
 * Build an ExtractedTableRecord from a vision-extracted table.
 */
export function buildExtractedTableRecord(
  table: VisionStructuredTable,
  documentHash: string,
  company: string | null,
  docType: string | null
): ExtractedTableRecord {
  return {
    source_document_id: documentHash,
    source_type: "financials",
    company_id: company || "unknown",
    company_name: company || "Unknown",
    table_name: table.table_name,
    table_type: table.table_type,
    fiscal_period: table.fiscal_period,
    fiscal_period_end: table.fiscal_period_end,
    currency: table.currency,
    table_unit: table.table_unit,
    comparative: table.comparative ?? false,
    headers: table.headers,
    rows: table.rows,
    raw_table_text: JSON.stringify(table.rows),
    extraction_model: VISION_MODEL,
  };
}

// ============================================================================
// Supabase Storage
// ============================================================================

/**
 * Store a structured table record in the extracted_tables table.
 * Returns the new row's UUID.
 */
export async function storeExtractedTable(
  supabase: SupabaseClient,
  record: ExtractedTableRecord
): Promise<string> {
  const { data, error } = await supabase
    .from("extracted_tables")
    .insert({
      source_document_id: record.source_document_id,
      source_type: record.source_type,
      company_id: record.company_id,
      company_name: record.company_name,
      table_name: record.table_name,
      table_type: record.table_type,
      fiscal_period: record.fiscal_period,
      fiscal_period_end: record.fiscal_period_end,
      currency: record.currency,
      table_unit: record.table_unit,
      comparative: record.comparative,
      headers: record.headers,
      rows: record.rows,
      raw_table_text: record.raw_table_text,
      extraction_model: record.extraction_model,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to store extracted table: ${error.message}`);
  }

  return data.id;
}

/**
 * Full extraction pipeline (text-based): structure a table via LLM, then persist it.
 * Used by the /api/extract/structure-table endpoint (marrow insurance pipeline).
 * Returns the extracted table's UUID and structured data.
 */
export async function extractAndStoreTable(
  supabase: SupabaseClient,
  aiGatewayToken: string,
  request: TableExtractionRequest
): Promise<{ id: string; structured: StructuredTable }> {
  // 1. Structure via LLM
  const structured = await structureTable(aiGatewayToken, request.raw_table_text, {
    company_name: request.company_name,
    policy_name: request.policy_name,
    doc_type: request.doc_type,
  });

  // 2. Persist to database
  const record: ExtractedTableRecord = {
    source_document_id: request.source_document_id,
    source_type: request.source_type,
    company_id: request.company_id,
    company_name: request.company_name,
    table_name: structured.table_name,
    table_type: structured.table_type,
    fiscal_period: structured.fiscal_period,
    fiscal_period_end: null,
    currency: structured.currency,
    table_unit: null,
    comparative: false,
    headers: structured.headers,
    rows: structured.rows,
    raw_table_text: request.raw_table_text,
    extraction_model: EXTRACTION_MODEL,
  };

  const id = await storeExtractedTable(supabase, record);

  return { id, structured };
}
