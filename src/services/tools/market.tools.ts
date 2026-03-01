/**
 * Market Data Tools — FinasaanGPT
 * Live structured data queries for PSX stocks and market summaries.
 * Queries companies + daily_stock_data tables and market_summary.
 */

import { tool } from "ai";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";

export function createMarketTools(supabase: SupabaseClient) {
  return {
    getMarketSummary: tool({
      description:
        "Get the latest KSE-100 and KSE-30 index values, daily change, and volume.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { data, error } = await supabase
            .from("market_summary")
            .select("*")
            .order("trade_date", { ascending: false })
            .limit(5);

          if (error) {
            throw new Error(`Market summary fetch failed: ${error.message}`);
          }

          return {
            indices: (data || []).map((row: Record<string, unknown>) => ({
              indexName: row.index_name,
              tradeDate: row.trade_date,
              previousClose: row.previous_close,
              currentClose: row.current_close,
              netChange: row.net_change,
              changePct: row.change_pct,
            })),
            timestamp: new Date().toISOString(),
          };
        } catch (err) {
          return {
            indices: [],
            error:
              err instanceof Error
                ? err.message
                : "Failed to fetch market data",
          };
        }
      },
    }),

    searchCompanies: tool({
      description:
        "Search PSX-listed companies by name or ticker symbol. Input: search query string and optional limit.",
      inputSchema: z.object({
        query: z.string().describe("Company name or ticker symbol"),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe("Max results to return"),
      }),
      execute: async ({ query, limit }) => {
        try {
          const { data, error } = await supabase
            .from("companies")
            .select("id, symbol, company_name, sector_id")
            .or(`symbol.ilike.%${query}%,company_name.ilike.%${query}%`)
            .order("symbol", { ascending: true })
            .limit(limit ?? 10);

          if (error) {
            throw new Error(`Company search failed: ${error.message}`);
          }

          return {
            query,
            companies: (data || []).map((c: Record<string, unknown>) => ({
              id: c.id,
              symbol: c.symbol,
              companyName: c.company_name,
              sectorId: c.sector_id,
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
        "Get detailed info about a specific PSX stock including latest price data. Input: ticker symbol string like PTCL, TRG, HBL.",
      inputSchema: z.object({
        symbol: z.string().describe("PSX ticker symbol, e.g. PTCL or HBL"),
      }),
      execute: async ({ symbol }) => {
        try {
          // Get company info
          const { data: company, error: cErr } = await supabase
            .from("companies")
            .select(
              "id, symbol, company_name, sector_id, description, website_url, ceo_name",
            )
            .ilike("symbol", symbol)
            .single();

          if (cErr || !company) {
            return {
              symbol,
              found: false,
              error: `Company with symbol '${symbol}' not found`,
            };
          }

          // Get latest price data
          const { data: priceData } = await supabase
            .from("daily_stock_data")
            .select(
              "trade_date, open_price, high_price, low_price, close_price, volume, value_traded",
            )
            .eq("company_id", company.id)
            .order("trade_date", { ascending: false })
            .limit(1)
            .single();

          return {
            symbol: company.symbol,
            companyName: company.company_name,
            sectorId: company.sector_id,
            description: company.description,
            ceoName: company.ceo_name,
            found: true,
            latestPrice: priceData
              ? {
                  tradeDate: priceData.trade_date,
                  open: priceData.open_price,
                  high: priceData.high_price,
                  low: priceData.low_price,
                  close: priceData.close_price,
                  volume: priceData.volume,
                  valueTraded: priceData.value_traded,
                }
              : null,
          };
        } catch (err) {
          return {
            symbol,
            found: false,
            error:
              err instanceof Error ? err.message : "Failed to fetch stock data",
          };
        }
      },
    }),

    getTopStocks: tool({
      description:
        "Get top-performing or most active PSX stocks by value traded on the latest trading day.",
      inputSchema: z.object({
        sortBy: z
          .enum(["value_traded", "volume", "close_price"])
          .optional()
          .default("value_traded")
          .describe("Sort by: value_traded, volume, or close_price"),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe("Number of stocks to return"),
      }),
      execute: async ({ sortBy, limit }) => {
        try {
          // Get latest trade date
          const { data: latestData } = await supabase
            .from("daily_stock_data")
            .select("trade_date")
            .order("trade_date", { ascending: false })
            .limit(1)
            .single();

          if (!latestData) {
            return { stocks: [], total: 0, error: "No trading data available" };
          }

          const { data, error } = await supabase
            .from("daily_stock_data")
            .select(
              `
              trade_date, open_price, close_price, volume, value_traded,
              companies!inner ( id, symbol, company_name, sector_id )
            `,
            )
            .eq("trade_date", latestData.trade_date)
            .order(sortBy ?? "value_traded", { ascending: false })
            .limit(limit ?? 10);

          if (error) {
            throw new Error(`Top stocks fetch failed: ${error.message}`);
          }

          return {
            tradeDate: latestData.trade_date,
            sortBy: sortBy ?? "value_traded",
            stocks: (data || []).map((d: Record<string, unknown>) => {
              const comp = d.companies as Record<string, unknown>;
              return {
                symbol: comp?.symbol,
                companyName: comp?.company_name,
                openPrice: d.open_price,
                closePrice: d.close_price,
                volume: d.volume,
                valueTraded: d.value_traded,
              };
            }),
            total: (data || []).length,
          };
        } catch (err) {
          return {
            stocks: [],
            total: 0,
            error:
              err instanceof Error ? err.message : "Failed to fetch top stocks",
          };
        }
      },
    }),
  };
}
