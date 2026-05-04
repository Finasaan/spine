/**
 * Market Data Tools — FinasaanGPT
 * Flexible structured data queries for PSX stocks, sectors, and market summaries.
 * Tables: companies, daily_stock_data, market_summary, sectors
 */

import { tool } from "ai";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";

export function createMarketTools(supabase: SupabaseClient) {
  return {
    getMarketSummary: tool({
      description:
        "Latest snapshot of PSX headline indices (KSE-100, KSE-30, and any others tracked in market_summary) — index name, previous close, current close, net change, and percent change. Use for market-overview questions: 'how is the market today', 'KSE-100 close', 'index movement'. Returns up to the 5 most recent index rows by trade_date. For specific stock prices use getStockDetail; for top-moving stocks use getTopStocks.",
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
        "Resolve a PSX ticker from a company name, or browse companies by sector. CALL THIS FIRST whenever you don't know the exact PSX ticker — NEVER guess or invent tickers. Examples: 'Meezan Bank' → searchCompanies({query:'Meezan'}) returns 'MEBL'; 'cement companies' → listSectors → searchCompanies({sectorId}). Returns company id, ticker (symbol), full name, sector_id. Once you have the ticker, hand off to getStockDetail / getStockHistory / queryFinancialTables. Does NOT return prices — use getStockDetail for price data.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Company name or ticker symbol to search"),
        sectorId: z
          .string()
          .optional()
          .describe(
            "Sector UUID to filter companies (get from listSectors tool)",
          ),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe("Max results to return"),
      }),
      execute: async ({ query, sectorId, limit }) => {
        try {
          let dbQuery = supabase
            .from("companies")
            .select("id, symbol, company_name, sector_id")
            .order("symbol", { ascending: true })
            .limit(limit ?? 10);

          if (query?.trim()) {
            dbQuery = dbQuery.or(
              `symbol.ilike.%${query}%,company_name.ilike.%${query}%`,
            );
          }

          if (sectorId) {
            dbQuery = dbQuery.eq("sector_id", sectorId);
          }

          const { data, error } = await dbQuery;

          if (error) {
            throw new Error(`Company search failed: ${error.message}`);
          }

          return {
            query: query || null,
            sectorId: sectorId || null,
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
            query: query || null,
            companies: [],
            total: 0,
            error: err instanceof Error ? err.message : "Search failed",
          };
        }
      },
    }),

    getStockDetail: tool({
      description:
        "Snapshot for ONE PSX stock: company profile (name, sector_id, description, CEO, website) + latest single-day price row (open, high, low, close, volume, value_traded). Pass the PSX ticker symbol (e.g. 'PTCL', 'HBL', 'MEBL'). Auto-falls-back to fuzzy matching on ticker+company name if exact match misses, but DO NOT guess — call searchCompanies first when unsure. For price history / trends use getStockHistory; for financial-statement figures (revenue, profit, EPS) use queryFinancialTables. RECOVERY: if this returns 'not found', call searchCompanies with the user's original phrase and retry — never give up after one miss.",
      inputSchema: z.object({
        symbol: z.string().describe("PSX ticker symbol (e.g. PTCL, HBL) or company name if ticker is unknown"),
      }),
      execute: async ({ symbol }) => {
        try {
          // Pass 1: exact ticker match
          let { data: company } = await supabase
            .from("companies")
            .select(
              "id, symbol, company_name, sector_id, description, website_url, ceo_name",
            )
            .ilike("symbol", symbol)
            .maybeSingle();

          // Pass 2: fuzzy match on ticker or company name
          if (!company) {
            const { data: fuzzy } = await supabase
              .from("companies")
              .select(
                "id, symbol, company_name, sector_id, description, website_url, ceo_name",
              )
              .or(`symbol.ilike.%${symbol}%,company_name.ilike.%${symbol}%`)
              .limit(1)
              .maybeSingle();
            company = fuzzy ?? null;
          }

          if (!company) {
            return {
              symbol,
              found: false,
              error: `Company '${symbol}' not found. Try searchCompanies to find the correct ticker.`,
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
        "Ranked list of PSX stocks for the LATEST trading day. sortBy: 'value_traded' (default — best proxy for liquidity / most-active), 'volume' (highest share count traded), or 'close_price' (highest priced). Optional sectorId narrows to one sector (call listSectors first to get the UUID). Use for 'top stocks', 'most active', 'highest volume', 'best performers in [sector]' style questions. Returns symbol, company name, open/close, volume, value traded for each. For a single stock's history use getStockHistory.",
      inputSchema: z.object({
        sortBy: z
          .enum(["value_traded", "volume", "close_price"])
          .optional()
          .default("value_traded")
          .describe("Sort by: value_traded, volume, or close_price"),
        sectorId: z
          .string()
          .optional()
          .describe(
            "Optional sector UUID to filter stocks by sector (get from listSectors)",
          ),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe("Number of stocks to return"),
      }),
      execute: async ({ sortBy, sectorId, limit }) => {
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

          let query = supabase
            .from("daily_stock_data")
            .select(
              `
              trade_date, open_price, close_price, volume, value_traded,
              companies!inner ( id, symbol, company_name, sector_id )
            `,
            )
            .eq("trade_date", latestData.trade_date);

          // Sector filter via the joined companies table
          if (sectorId) {
            query = query.eq("companies.sector_id", sectorId);
          }

          query = query
            .order(sortBy ?? "value_traded", { ascending: false })
            .limit(limit ?? 10);

          const { data, error } = await query;

          if (error) {
            throw new Error(`Top stocks fetch failed: ${error.message}`);
          }

          return {
            tradeDate: latestData.trade_date,
            sortBy: sortBy ?? "value_traded",
            sectorId: sectorId || null,
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

    listSectors: tool({
      description:
        "List every PSX sector / industry classification with its UUID and name (e.g. 'Commercial Banks', 'Oil & Gas Exploration', 'Cement'). Call this BEFORE any tool that takes a sectorId parameter (searchCompanies, getTopStocks, queryMutualFunds via category resolution) when you need to filter by a specific sector. Cheap call — safe to run whenever sector classification is in play.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { data, error } = await supabase
            .from("sectors")
            .select("id, name")
            .order("name", { ascending: true });

          if (error) {
            throw new Error(`Sectors fetch failed: ${error.message}`);
          }

          return {
            sectors: data || [],
            total: (data || []).length,
          };
        } catch (err) {
          return {
            sectors: [],
            total: 0,
            error:
              err instanceof Error ? err.message : "Failed to fetch sectors",
          };
        }
      },
    }),

    getStockHistory: tool({
      description:
        "Daily OHLCV history (open, high, low, close, volume, value_traded) for ONE PSX stock — use for trend analysis, % change over a window, performance charts, volatility. Pass the PSX ticker symbol (e.g. 'ENGRO', 'HBL'). 'days' parameter sets the lookback window in trading days (default 30, max 1825 = ~5 years). Auto-fuzzy-matches ticker / company name as a fallback, but call searchCompanies first when unsure. RECOVERY: if 'not found', call searchCompanies and retry. For latest single-day price use getStockDetail; for financial-statement figures use queryFinancialTables.",
      inputSchema: z.object({
        symbol: z.string().describe("PSX ticker symbol (e.g. ENGRO, HBL) or company name if ticker is unknown"),
        days: z.coerce
          .number()
          .int()
          .min(1)
          .max(1825)
          .optional()
          .default(30)
          .describe(
            "Number of trading days of history (default 30, max 1825 = ~5 years)",
          ),
      }),
      execute: async ({ symbol, days }) => {
        try {
          // Pass 1: exact ticker match
          let { data: company } = await supabase
            .from("companies")
            .select("id, symbol, company_name")
            .ilike("symbol", symbol)
            .maybeSingle();

          // Pass 2: fuzzy match on ticker or company name
          if (!company) {
            const { data: fuzzy } = await supabase
              .from("companies")
              .select("id, symbol, company_name")
              .or(`symbol.ilike.%${symbol}%,company_name.ilike.%${symbol}%`)
              .limit(1)
              .maybeSingle();
            company = fuzzy ?? null;
          }

          if (!company) {
            return {
              symbol,
              found: false,
              error: `Company '${symbol}' not found. Try searchCompanies to find the correct ticker.`,
            };
          }

          const { data, error } = await supabase
            .from("daily_stock_data")
            .select(
              "trade_date, open_price, high_price, low_price, close_price, volume, value_traded",
            )
            .eq("company_id", company.id)
            .order("trade_date", { ascending: false })
            .limit(days ?? 30);

          if (error) {
            throw new Error(`Stock history fetch failed: ${error.message}`);
          }

          return {
            symbol: company.symbol,
            companyName: company.company_name,
            days: days ?? 30,
            history: (data || []).map((d: Record<string, unknown>) => ({
              date: d.trade_date,
              open: d.open_price,
              high: d.high_price,
              low: d.low_price,
              close: d.close_price,
              volume: d.volume,
              valueTraded: d.value_traded,
            })),
            total: (data || []).length,
          };
        } catch (err) {
          return {
            symbol,
            found: false,
            history: [],
            total: 0,
            error:
              err instanceof Error
                ? err.message
                : "Failed to fetch stock history",
          };
        }
      },
    }),
  };
}
