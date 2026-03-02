/**
 * Knowledge Tools — FinasaanGPT
 * Semantic RAG search over finasaan_documents and conversation_document_chunks.
 */

import { tool } from "ai";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";
import { generateEmbedding } from "../ai.service";

export function createKnowledgeTools(supabase: SupabaseClient, ai: Ai, sessionId: string) {
  return {
    searchKnowledge: tool({
      description:
        "Search the Finasaan knowledge base using semantic search. Use this for: insurance products/policies/comparisons, company annual reports, financial literacy topics, regulatory information, and any financial question not answerable by structured stock/fund data tools. This is the primary tool for insurance-related queries.",
      inputSchema: z.object({
        query: z.string().describe("Search query string"),
        domain: z
          .enum(["financials", "insurance", "mutual_funds", "all"])
          .optional()
          .default("all")
          .describe(
            "Domain filter: financials, insurance, mutual_funds, or all",
          ),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .default(5)
          .describe("Number of results"),
      }),
      execute: async ({ query, domain, limit }) => {
        try {
          const embedding = await generateEmbedding(ai, query);
          const vectorStr = JSON.stringify(embedding);

          const { data, error } = await supabase.rpc(
            "search_finasaan_documents",
            {
              query_embedding: vectorStr,
              match_limit: limit ?? 5,
              filter_domain: domain === "all" ? null : (domain ?? null),
              min_similarity: 0.45,
            },
          );

          if (error) {
            throw new Error(`Knowledge search failed: ${error.message}`);
          }

          const results = (data || []) as Array<{
            id: number;
            domain: string;
            content: string;
            metadata: Record<string, unknown>;
            source_url: string | null;
            similarity: number;
          }>;

          return {
            query,
            domain: domain ?? "all",
            results: results.map((r) => ({
              id: r.id,
              domain: r.domain,
              content: r.content,
              metadata: r.metadata,
              similarity: Math.round(r.similarity * 1000) / 1000,
            })),
            total: results.length,
          };
        } catch (err) {
          return {
            query,
            domain: domain ?? "all",
            results: [],
            total: 0,
            error: err instanceof Error ? err.message : "Search failed",
          };
        }
      },
    }),

    searchConversationDocument: tool({
      description:
        "Search within documents the user uploaded to this conversation. Use this whenever the user asks about an uploaded file or document.",
      inputSchema: z.object({
        query: z.string().describe("Search query string"),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .default(4)
          .describe("Number of chunks to retrieve"),
      }),
      execute: async ({ query, limit }) => {
        try {
          const embedding = await generateEmbedding(ai, query);
          const vectorStr = JSON.stringify(embedding);

          const { data, error } = await supabase.rpc(
            "search_conversation_chunks",
            {
              query_embedding: vectorStr,
              p_session_id: sessionId,
              match_limit: limit ?? 4,
              min_similarity: 0.4,
            },
          );

          if (error) {
            throw new Error(`Document search failed: ${error.message}`);
          }

          const results = (data || []) as Array<{
            id: number;
            filename: string;
            chunk_index: number;
            content: string;
            similarity: number;
          }>;

          return {
            query,
            sessionId,
            results: results.map((r) => ({
              filename: r.filename,
              chunk_index: r.chunk_index,
              content: r.content,
              similarity: Math.round(r.similarity * 1000) / 1000,
            })),
            total: results.length,
          };
        } catch (err) {
          return {
            query,
            sessionId,
            results: [],
            total: 0,
            error: err instanceof Error ? err.message : "Document search failed",
          };
        }
      },
    }),
  };
}
