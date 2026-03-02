/**
 * Extraction Controller
 * Handles HTTP requests for the table extraction endpoint.
 * Called by marrow to structure raw table text via LLM.
 */

import { Context } from "hono";
import { getSupabaseClient } from "../db";
import {
  extractAndStoreTable,
  TableExtractionRequest,
} from "../services/extraction.service";

// ============================================================================
// Helper
// ============================================================================

function getAIGatewayToken(c: Context<{ Bindings: CloudflareBindings }>): string {
  const token = (c.env as unknown as { AI_GATEWAY_TOKEN: string })
    .AI_GATEWAY_TOKEN;
  if (!token) {
    throw new Error("AI_GATEWAY_TOKEN not configured");
  }
  return token;
}

// ============================================================================
// Endpoint
// ============================================================================

/**
 * Structure a raw table and store the result.
 * POST /api/extract/structure-table
 *
 * Body: {
 *   raw_table_text: string;
 *   source_document_id: string;
 *   source_type: string;        // e.g. "insurance"
 *   company_id: string;
 *   company_name: string;
 *   policy_name?: string;
 *   doc_type?: string;
 * }
 *
 * Response: {
 *   success: true;
 *   table_id: string;
 *   structured: { table_name, table_type, fiscal_period, currency, headers, rows }
 * }
 */
export async function handleStructureTable(
  c: Context<{ Bindings: CloudflareBindings }>
) {
  try {
    const body = await c.req.json<TableExtractionRequest>();

    // Validate required fields
    if (!body.raw_table_text?.trim()) {
      return c.json({ success: false, error: "No raw_table_text provided" }, 400);
    }
    if (!body.source_document_id) {
      return c.json({ success: false, error: "No source_document_id provided" }, 400);
    }
    if (!body.company_id || !body.company_name) {
      return c.json({ success: false, error: "company_id and company_name are required" }, 400);
    }

    const supabase = await getSupabaseClient(c.env);
    const aiGatewayToken = getAIGatewayToken(c);

    const { id, structured } = await extractAndStoreTable(
      supabase,
      aiGatewayToken,
      {
        raw_table_text: body.raw_table_text,
        source_document_id: body.source_document_id,
        source_type: body.source_type || "insurance",
        company_id: body.company_id,
        company_name: body.company_name,
        policy_name: body.policy_name,
        doc_type: body.doc_type,
      }
    );

    return c.json({
      success: true,
      table_id: id,
      structured,
    });
  } catch (error) {
    console.error("[Extraction] Structure table error:", error);
    return c.json(
      {
        success: false,
        error: "Table extraction failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
}
