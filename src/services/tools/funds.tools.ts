/**
 * Mutual Funds Tools — FinasaanGPT
 * Queries for Pakistani mutual funds.
 * Schema: mutual_funds(id, symbol, name, provider_id, sector_id, description, inception_date)
 */

import { tool } from "ai";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";

export function createFundsTools(supabase: SupabaseClient) {
  return {
    searchMutualFunds: tool({
      description:
        "Search Pakistani mutual funds by name or symbol. Input: query string.",
      inputSchema: z.object({
        query: z.string().describe("Fund name or symbol to search"),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe("Max results"),
      }),
      execute: async ({ query, limit }) => {
        try {
          const { data, error } = await supabase
            .from("mutual_funds")
            .select(
              "id, symbol, name, provider_id, sector_id, description, inception_date",
            )
            .or(`name.ilike.%${query}%,symbol.ilike.%${query}%`)
            .order("name", { ascending: true })
            .limit(limit ?? 10);

          if (error) {
            throw new Error(`Fund search failed: ${error.message}`);
          }

          return {
            query,
            funds: (data || []).map((f: Record<string, unknown>) => ({
              id: f.id,
              symbol: f.symbol,
              name: f.name,
              providerId: f.provider_id,
              sectorId: f.sector_id,
              description: f.description,
              inceptionDate: f.inception_date,
            })),
            total: (data || []).length,
          };
        } catch (err) {
          return {
            query,
            funds: [],
            total: 0,
            error: err instanceof Error ? err.message : "Fund search failed",
          };
        }
      },
    }),

    getFundDetail: tool({
      description:
        "Get detailed info about a specific mutual fund. Input: fund ID or fund name.",
      inputSchema: z.object({
        fundId: z
          .string()
          .optional()
          .describe("Fund UUID from a previous search"),
        fundName: z.string().optional().describe("Fund name to search"),
      }),
      execute: async ({ fundId, fundName }) => {
        try {
          if (!fundId && !fundName) {
            return { found: false, error: "Provide either fundId or fundName" };
          }

          let dbQuery = supabase.from("mutual_funds").select("*");

          if (fundId) {
            dbQuery = dbQuery.eq("id", fundId);
          } else if (fundName) {
            dbQuery = dbQuery.ilike("name", `%${fundName}%`);
          }

          const { data, error } = await dbQuery.limit(1).single();

          if (error || !data) {
            return {
              found: false,
              error: `Fund not found: ${fundId || fundName}`,
            };
          }

          const f = data as Record<string, unknown>;

          return {
            found: true,
            id: f.id,
            symbol: f.symbol,
            name: f.name,
            providerId: f.provider_id,
            sectorId: f.sector_id,
            description: f.description,
            inceptionDate: f.inception_date,
          };
        } catch (err) {
          return {
            found: false,
            error:
              err instanceof Error
                ? err.message
                : "Failed to fetch fund details",
          };
        }
      },
    }),
  };
}
