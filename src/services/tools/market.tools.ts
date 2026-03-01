/**
 * Market Data Tools — FinasaanGPT
 * Live structured data queries for PSX stocks and market summaries.
 */

import { tool } from "ai";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";

export function createMarketTools(supabase: SupabaseClient) {
  return {
    getMarketSummary: tool({
      description:
        "Get the latest KSE-100 and KSE-30 index summary including current value, daily change, and volume. Use this when asked about the overall market, how the market is doing today, or general market conditions.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { data, error } = await supabase
            .from("market_summary")
            .select("*")
            .order("updated_at", { ascending: false })
            .limit(5);

          if (error) {
            throw new Error(`Market summary fetch failed: ${error.message}`);
          }

          return {
            indices: (data || []).map((row: Record<string, unknown>) => ({
              index: row.index_name,
              value: row.current_value,
              change: row.change_points,
              changePercent: row.change_percent,
              volume: row.volume,
              updatedAt: row.updated_at,
            })),
            timestamp: new Date().toISOString(),
          };
        } catch (err) {
          return {
            indices: [],
            error: err instanceof Error ? err.message : "Failed to fetch market data",
          };
        }
      },
    }),

    searchCompanies: tool({
      description:
        "Search for PSX-listed companies by name or ticker symbol. Use this when the user asks about a specific stock, company, or wants to find companies in a sector.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Company name or ticker symbol to search for"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe("Maximum number of results"),
      }),
      execute: async ({ query, limit }) => {
        try {
          const { data, error } = await supabase
            .from("companies")
            .select(
              "id, symbol, name, sector, current_price, change_percent, volume, market_cap"
            )
            .or(`symbol.ilike.%${query}%,name.ilike.%${query}%`)
            .order("market_cap", { ascending: false, nullsFirst: false })
            .limit(limit ?? 10);

          if (error) {
            throw new Error(`Company search failed: ${error.message}`);
          }

          return {
            query,
            companies: (data || []).map((c: Record<string, unknown>) => ({
              id: c.id,
              symbol: c.symbol,
              name: c.name,
              sector: c.sector,
              price: c.current_price,
              changePercent: c.change_percent,
              volume: c.volume,
              marketCap: c.market_cap,
            })),
            total: (data || []).length,
          };
        } catch (err) {
          return {
            query,
            companies: [],
            total: 0,
            error: err instanceof Error ? err.message : "Search failed",
          };
        }
      },
    }),

    getStockDetail: tool({
      description:
        "Get detailed information about a specific PSX stock by its ticker symbol, including price, change, volume, and recent trading data.",
      inputSchema: z.object({
        symbol: z
          .string()
          .describe("The PSX ticker symbol (e.g. 'PTCL', 'TRG', 'HBL')"),
      }),
      execute: async ({ symbol }) => {
        try {
          const { data, error } = await supabase
            .from("companies")
            .select("*")
            .ilike("symbol", symbol)
            .single();

          if (error || !data) {
            return {
              symbol,
              found: false,
              error: `Company with symbol '${symbol}' not found`,
            };
          }

          const company = data as Record<string, unknown>;

          return {
            symbol: company.symbol,
            name: company.name,
            sector: company.sector,
            price: company.current_price,
            changePoints: company.change_points,
            changePercent: company.change_percent,
            volume: company.volume,
            marketCap: company.market_cap,
            high52w: company.high_52w,
            low52w: company.low_52w,
            peRatio: company.pe_ratio,
            eps: company.eps,
            found: true,
          };
        } catch (err) {
          return {
            symbol,
            found: false,
            error: err instanceof Error ? err.message : "Failed to fetch stock data",
          };
        }
      },
    }),

    getTopStocks: tool({
      description:
        "Get a ranked list of top-performing or most active PSX stocks. Use this when the user asks for top gainers, losers, most active stocks, or best performers.",
      inputSchema: z.object({
        sortBy: z
          .enum(["change_percent", "volume", "market_cap", "current_price"])
          .optional()
          .default("change_percent")
          .describe(
            "Sort stocks by: 'change_percent' (top gainers/losers), 'volume' (most active), 'market_cap' (largest companies)"
          ),
        order: z
          .enum(["desc", "asc"])
          .optional()
          .default("desc")
          .describe("'desc' for top gainers or largest, 'asc' for bottom performers"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe("Number of stocks to return"),
        sector: z
          .string()
          .optional()
          .describe("Filter by sector name (optional)"),
      }),
      execute: async ({ sortBy, order, limit, sector }) => {
        try {
          let query = supabase
            .from("companies")
            .select("symbol, name, sector, current_price, change_percent, change_points, volume, market_cap")
            .not("current_price", "is", null);

          if (sector) {
            query = query.ilike("sector", `%${sector}%`);
          }

          const ascending = order === "asc";
          query = query
            .order(sortBy ?? "change_percent", {
              ascending,
              nullsFirst: false,
            })
            .limit(limit ?? 10);

          const { data, error } = await query;

          if (error) {
            throw new Error(`Top stocks fetch failed: ${error.message}`);
          }

          return {
            sortBy: sortBy ?? "change_percent",
            order: order ?? "desc",
            sector: sector ?? null,
            stocks: (data || []).map((c: Record<string, unknown>) => ({
              symbol: c.symbol,
              name: c.name,
              sector: c.sector,
              price: c.current_price,
              change: c.change_points,
              changePercent: c.change_percent,
              volume: c.volume,
              marketCap: c.market_cap,
            })),
            total: (data || []).length,
          };
        } catch (err) {
          return {
            sortBy: sortBy ?? "change_percent",
            stocks: [],
            total: 0,
            error: err instanceof Error ? err.message : "Failed to fetch top stocks",
          };
        }
      },
    }),
  };
}
