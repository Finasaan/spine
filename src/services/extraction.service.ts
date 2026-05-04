/**
 * Extraction Service
 * LLM-powered table structuring for the document ingestion pipeline.
 *
 * Two extraction entry points, both text-only on Cloudflare Workers
 * (PDF page rendering via pdf.js is not Workers-compatible):
 * 1. Single raw table → Llama 3.3 70B → structured JSON
 *    (insurance pipeline via /api/extract/structure-table)
 * 2. Whole page text → Llama 3.3 70B → tables[] + prose
 *    (spine's handleUploadPDF for table-heavy and scanned pages)
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { AI_GATEWAY_CONFIG } from "../types/chatbot.types";

// Strip characters that PostgreSQL rejects when payloads arrive as JSON via
// PostgREST: null bytes and lone UTF-16 surrogates. PDF-derived text can
// leak these and trigger "unsupported Unicode escape sequence" on insert.
const NUL_RE = new RegExp(String.fromCharCode(0), "g");
const LONE_SURROGATE_RE = /[\uD800-\uDFFF]/g;
function pgSanitize<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(NUL_RE, "").replace(LONE_SURROGATE_RE, "") as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => pgSanitize(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = pgSanitize(v);
    }
    return out as T;
  }
  return value;
}

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
// Types — Per-Page Extraction
// ============================================================================

/** Result from a single page processed by the page-extraction model */
export interface PageExtractionResult {
  prose: string;
  tables: PageStructuredTable[];
}

/** A single table extracted from a page */
export interface PageStructuredTable {
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
const PAGE_EXTRACTION_MODEL = "llama-3.3-70b-versatile";

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
 * System prompt for whole-page extraction (financial document pipeline).
 * Input is the raw text of one PDF page (as extracted by unpdf), which may
 * contain collapsed columns, whitespace-aligned tables, or messy artifacts.
 */
const PAGE_EXTRACTION_PROMPT = `You are a financial document data extraction assistant. You will be given the raw text of a single page from a Pakistani company's financial document, extracted from a PDF. The text may have inconsistent formatting: column-aligned tables collapsed into whitespace, pipe-separated artifacts, broken row order, or near-empty content from a scanned page.

Your task:
1. Recover and normalize ALL tables on this page into structured JSON.
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
// Per-Page Extraction (used by financial document pipeline)
// ============================================================================

/**
 * Extract tables and prose from a single PDF page's raw text.
 * Uses Llama 3.3 70B in JSON mode — no images, since PDF rendering doesn't
 * work in Cloudflare Workers. Whatever unpdf could pull off the page is what
 * the model sees; for fully scanned pages this will often be near-empty and
 * the LLM will return empty tables and minimal prose, which is fine.
 */
export async function extractPageTablesAndProse(
  aiGatewayToken: string,
  pageText: string,
  context: {
    company_name: string;
    doc_type?: string;
    pageNumber: number;
    totalPages: number;
  }
): Promise<PageExtractionResult> {
  const userMessage = [
    `Company: ${context.company_name}`,
    context.doc_type ? `Document type: ${context.doc_type}` : null,
    `Page: ${context.pageNumber} of ${context.totalPages}`,
    "",
    "Page text:",
    "```",
    pageText,
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
        model: `groq/${PAGE_EXTRACTION_MODEL}`,
        messages: [
          { role: "system", content: PAGE_EXTRACTION_PROMPT },
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
      `AI Gateway error during page extraction: ${response.status} - ${errorText}`
    );
  }

  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (result.error) {
    throw new Error(`Groq error during page extraction: ${result.error.message}`);
  }

  const raw = result.choices?.[0]?.message?.content?.trim();
  if (!raw) {
    throw new Error("No response from page extraction model");
  }

  const parsed = JSON.parse(raw) as PageExtractionResult;

  return {
    prose: typeof parsed.prose === "string" ? parsed.prose : "",
    tables: Array.isArray(parsed.tables) ? parsed.tables : [],
  };
}

// ============================================================================
// Page Table Validation
// ============================================================================

/**
 * Validate a page-extracted table before storage.
 * Must have name, type, headers, at least one row with a non-null numeric value.
 */
export function isPageTableValid(table: PageStructuredTable): boolean {
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
 * Build an ExtractedTableRecord from a page-extracted table.
 */
export function buildExtractedTableRecord(
  table: PageStructuredTable,
  documentHash: string,
  company: string | null,
  _docType: string | null
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
    extraction_model: PAGE_EXTRACTION_MODEL,
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
      company_name: pgSanitize(record.company_name),
      table_name: pgSanitize(record.table_name),
      table_type: record.table_type,
      fiscal_period: pgSanitize(record.fiscal_period),
      fiscal_period_end: record.fiscal_period_end,
      currency: pgSanitize(record.currency),
      table_unit: pgSanitize(record.table_unit),
      comparative: record.comparative,
      headers: pgSanitize(record.headers),
      rows: pgSanitize(record.rows),
      raw_table_text: pgSanitize(record.raw_table_text),
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
 * Store multiple structured table records in a single batch.
 * Dramatically reduces subrequest count for long documents.
 */
export async function storeExtractedTables(
  supabase: SupabaseClient,
  records: ExtractedTableRecord[]
): Promise<string[]> {
  if (records.length === 0) return [];

  const { data, error } = await supabase
    .from("extracted_tables")
    .insert(
      records.map((record) => ({
        source_document_id: record.source_document_id,
        source_type: record.source_type,
        company_id: record.company_id,
        company_name: pgSanitize(record.company_name),
        table_name: pgSanitize(record.table_name),
        table_type: record.table_type,
        fiscal_period: pgSanitize(record.fiscal_period),
        fiscal_period_end: record.fiscal_period_end,
        currency: pgSanitize(record.currency),
        table_unit: pgSanitize(record.table_unit),
        comparative: record.comparative,
        headers: pgSanitize(record.headers),
        rows: pgSanitize(record.rows),
        raw_table_text: pgSanitize(record.raw_table_text),
        extraction_model: record.extraction_model,
      }))
    )
    .select("id");

  if (error) {
    throw new Error(`Failed to store extracted tables batch: ${error.message}`);
  }

  return (data || []).map((row) => row.id);
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
