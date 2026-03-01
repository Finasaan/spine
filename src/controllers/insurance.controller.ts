/**
 * Insurance Controller
 * Handles insurance document ingestion (from marrow) and search endpoints
 * Spine is the AI gatekeeper — embedding generation happens here
 */

import { Context } from "hono";
import { getSupabaseClient } from "../db";
import {
  generateEmbedding,
  generateEmbeddings,
} from "../services/chatbot.service";
import {
  insuranceDocumentExists,
  storeInsuranceDocument,
  storeInsuranceChunks,
  searchInsuranceChunks,
  InsuranceDocumentRecord,
  InsuranceChunkInput,
} from "../services/insurance.service";

// ============================================================================
// Ingest Endpoint (called by marrow)
// ============================================================================

/**
 * Receive preprocessed document + chunks from marrow, generate embeddings, store
 * POST /api/insurance/ingest
 *
 * Body: {
 *   document: InsuranceDocumentRecord,
 *   chunks: InsuranceChunkInput[]
 * }
 */
export async function handleInsuranceIngest(
  c: Context<{ Bindings: CloudflareBindings }>
) {
  try {
    const body = await c.req.json<{
      document: InsuranceDocumentRecord;
      chunks: InsuranceChunkInput[];
    }>();

    // Validate
    if (!body.document?.document_hash) {
      return c.json({ success: false, error: "Missing document data" }, 400);
    }
    if (!body.chunks?.length) {
      return c.json({ success: false, error: "No chunks provided" }, 400);
    }

    const supabase = await getSupabaseClient(c.env);
    const ai = c.env.AI;

    // 1. Check for duplicate document hash
    const exists = await insuranceDocumentExists(
      supabase,
      body.document.document_hash
    );
    if (exists) {
      return c.json({
        success: true,
        message: "Document already exists (duplicate hash)",
        skipped: true,
        chunks_stored: 0,
      });
    }

    // 2. Store document record
    console.log(
      `[Insurance Ingest] Storing document: ${body.document.policy_name} (${body.document.company_id})`
    );
    const documentId = await storeInsuranceDocument(supabase, body.document);

    // 3. Generate embeddings for all chunks
    const texts = body.chunks.map((chunk) => chunk.text);
    console.log(
      `[Insurance Ingest] Generating embeddings for ${texts.length} chunks`
    );

    // Process in batches of 20 to avoid AI model limits
    const EMBED_BATCH_SIZE = 20;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      const embeddings = await generateEmbeddings(ai, batch);
      allEmbeddings.push(...embeddings);
    }

    // 4. Store chunks with embeddings
    const chunksStored = await storeInsuranceChunks(
      supabase,
      documentId,
      body.document.company_id,
      body.chunks,
      allEmbeddings
    );

    console.log(
      `[Insurance Ingest] Stored ${chunksStored} chunks for document ${documentId}`
    );

    return c.json({
      success: true,
      document_id: documentId,
      chunks_stored: chunksStored,
    });
  } catch (error) {
    console.error("[Insurance Ingest] Error:", error);
    return c.json(
      {
        success: false,
        error: "Insurance ingestion failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
}

// ============================================================================
// Search Endpoint
// ============================================================================

/**
 * Search insurance document chunks
 * POST /api/insurance/search
 *
 * Body: {
 *   query: string,
 *   company_id?: string,
 *   chunk_type?: "body" | "table",
 *   limit?: number,
 *   min_similarity?: number
 * }
 */
export async function handleInsuranceSearch(
  c: Context<{ Bindings: CloudflareBindings }>
) {
  try {
    const body = await c.req.json<{
      query: string;
      company_id?: string;
      chunk_type?: string;
      limit?: number;
      min_similarity?: number;
    }>();

    if (!body.query?.trim()) {
      return c.json({ error: "No query provided" }, 400);
    }

    const supabase = await getSupabaseClient(c.env);
    const ai = c.env.AI;

    // 1. Generate query embedding
    const queryEmbedding = await generateEmbedding(ai, body.query.trim());

    // 2. Search insurance chunks
    const results = await searchInsuranceChunks(supabase, queryEmbedding, {
      limit: body.limit || 5,
      company_id: body.company_id,
      chunk_type: body.chunk_type,
      min_similarity: body.min_similarity || 0.5,
    });

    return c.json({
      success: true,
      results,
      count: results.length,
      query: body.query.trim(),
      filters: {
        company_id: body.company_id || null,
        chunk_type: body.chunk_type || null,
      },
    });
  } catch (error) {
    console.error("[Insurance Search] Error:", error);
    return c.json(
      {
        error: "Insurance search failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
}
