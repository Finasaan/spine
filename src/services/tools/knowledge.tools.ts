/**
 * Knowledge Tools — FinasaanGPT
 * Semantic RAG search over finasaan_documents and conversation_document_chunks.
 */

import { tool } from "ai";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";
import { generateEmbedding } from "../ai.service";

export function createKnowledgeTools(supabase: SupabaseClient, ai: Ai) {
  return {
    searchKnowledge: tool({
      description:
        "Search the Finasaan knowledge base for information about Pakistani stocks, company financial reports, insurance products, and mutual funds. Use this for any question about financial documents, company performance, coverage details, or investment products.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("The search query to find relevant information"),
        domain: z
          .enum(["financials", "insurance", "mutual_funds", "all"])
          .optional()
          .default("all")
          .describe(
            "Knowledge domain to search: 'financials' for company reports, 'insurance' for insurance products, 'mutual_funds' for fund data, 'all' for everything"
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .default(5)
          .describe("Number of results to return"),
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
            }
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
        "Search within documents that the user has uploaded to this conversation. Use this when the user refers to an attached file or asks about content from their uploaded PDF.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("The search query to find relevant content in the document"),
        sessionId: z
          .string()
          .describe("The current chat session ID"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .default(4)
          .describe("Number of chunks to retrieve"),
      }),
      execute: async ({ query, sessionId, limit }) => {
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
            }
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
