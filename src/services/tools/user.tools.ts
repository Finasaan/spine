/**
 * User Tools — FinasaanGPT
 * Authenticated queries for user portfolio and watchlist.
 * Tables: user_portfolios, user_portfolio_holdings, user_watchlists
 */

import { tool } from "ai";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";
import { generatePortfolioAISummary } from "../portfolio.ai.service";

export function createUserTools(
  supabase: SupabaseClient, 
  userId: string,
  env?: { AI_GATEWAY_TOKEN?: string; AI_GATEWAY_BASE_URL?: string }
) {
  return {
    getUserPortfolio: tool({
      description:
        "The AUTHENTICATED user's own investment portfolios and holdings (scoped to their userId — never returns anyone else's data). Two modes: omit portfolioId to list all of their portfolios (id, name, description, createdAt); pass a specific portfolioId to drill into ONE portfolio's holdings — each holding shows assetType ('stock' | 'fund'), symbol, name, quantity, purchase price/date, notes. Use for 'my portfolio', 'my holdings', 'what stocks/funds do I own', 'show my investments'. For an analytical health summary (P/L, news impact) use getPortfolioInsight; for tracked-but-not-owned items use getUserWatchlist.",
      inputSchema: z.object({
        portfolioId: z
          .string()
          .optional()
          .describe(
            "Specific portfolio UUID. If omitted, returns all portfolios.",
          ),
      }),
      execute: async ({ portfolioId }) => {
        try {
          if (portfolioId) {
            // Fetch specific portfolio with holdings
            const { data: portfolio, error: pErr } = await supabase
              .from("user_portfolios")
              .select("id, name, description, created_at")
              .eq("id", portfolioId)
              .eq("user_id", userId)
              .single();

            if (pErr || !portfolio) {
              return { found: false, error: "Portfolio not found" };
            }

            const { data: holdings, error: hErr } = await supabase
              .from("user_portfolio_holdings")
              .select(
                `
                id, quantity, purchase_price, purchase_date, notes,
                companies ( id, symbol, company_name ),
                mutual_funds ( id, symbol, name )
              `,
              )
              .eq("portfolio_id", portfolioId);

            if (hErr) {
              throw new Error(`Holdings fetch failed: ${hErr.message}`);
            }

            const p = portfolio as Record<string, unknown>;

            return {
              found: true,
              portfolio: {
                id: p.id,
                name: p.name,
                description: p.description,
                holdings: (holdings || []).map((h: Record<string, unknown>) => {
                  const company = h.companies as Record<string, unknown> | null;
                  const fund = h.mutual_funds as Record<string, unknown> | null;
                  return {
                    id: h.id,
                    assetType: company ? "stock" : "fund",
                    symbol: company?.symbol ?? fund?.symbol,
                    name: company?.company_name ?? fund?.name,
                    quantity: h.quantity,
                    purchasePrice: h.purchase_price,
                    purchaseDate: h.purchase_date,
                    notes: h.notes,
                  };
                }),
              },
            };
          } else {
            // Fetch all portfolios (summary only)
            const { data, error } = await supabase
              .from("user_portfolios")
              .select("id, name, description, created_at")
              .eq("user_id", userId)
              .order("created_at", { ascending: false });

            if (error) {
              throw new Error(`Portfolios fetch failed: ${error.message}`);
            }

            return {
              portfolios: (data || []).map((p: Record<string, unknown>) => ({
                id: p.id,
                name: p.name,
                description: p.description,
                createdAt: p.created_at,
              })),
              total: (data || []).length,
            };
          }
        } catch (err) {
          return {
            found: false,
            error:
              err instanceof Error ? err.message : "Failed to fetch portfolio",
          };
        }
      },
    }),

    getUserWatchlist: tool({
      description:
        "The AUTHENTICATED user's watchlist — stocks and mutual funds they're TRACKING but do not necessarily own (no quantities or purchase data). Returns assetType, symbol, name for each entry. Use for 'my watchlist', 'saved stocks', 'what am I tracking', 'stocks I'm following'. For owned holdings use getUserPortfolio.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { data, error } = await supabase
            .from("user_watchlists")
            .select(
              `
              id,
              companies ( id, symbol, company_name ),
              mutual_funds ( id, symbol, name )
            `,
            )
            .eq("user_id", userId);

          if (error) {
            throw new Error(`Watchlist fetch failed: ${error.message}`);
          }

          return {
            watchlist: (data || []).map((item: Record<string, unknown>) => {
              const company = item.companies as Record<string, unknown> | null;
              const fund = item.mutual_funds as Record<string, unknown> | null;
              return {
                id: item.id,
                assetType: company ? "stock" : "fund",
                symbol: company?.symbol ?? fund?.symbol,
                name: company?.company_name ?? fund?.name,
              };
            }),
            total: (data || []).length,
          };
        } catch (err) {
          return {
            watchlist: [],
            total: 0,
            error:
              err instanceof Error ? err.message : "Failed to fetch watchlist",
          };
        }
      },
    }),

    getPortfolioInsight: tool({
      description:
        "AI-generated health analysis of the AUTHENTICATED user's portfolio — combines current holdings, profit/loss against purchase prices, and recent news affecting held tickers into a single narrative summary. Use for 'analyze my portfolio', 'how am I doing', 'portfolio health', 'should I rebalance'. EXPENSIVE call (runs an internal LLM pass) — do NOT call this for simple 'what do I own' queries; use getUserPortfolio for that.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const result = await generatePortfolioAISummary(
            supabase,
            userId,
            env || {} 
          );
          return result;
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : "Failed to generate portfolio insight",
          };
        }
      },
    }),
  };
}
