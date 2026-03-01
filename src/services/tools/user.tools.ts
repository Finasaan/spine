/**
 * User Tools — FinasaanGPT
 * Authenticated queries for user portfolio and watchlist.
 */

import { tool } from "ai";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";

export function createUserTools(supabase: SupabaseClient, userId: string) {
  return {
    getUserPortfolio: tool({
      description:
        "Get the user's investment portfolios and their holdings. Use this when the user asks about their portfolio, investments, holdings, or how their stocks are performing.",
      inputSchema: z.object({
        portfolioId: z
          .string()
          .optional()
          .describe(
            "Specific portfolio UUID to fetch. If omitted, returns all portfolios."
          ),
      }),
      execute: async ({ portfolioId }) => {
        try {
          if (portfolioId) {
            // Fetch specific portfolio with holdings
            const { data: portfolio, error: pErr } = await supabase
              .from("portfolios")
              .select("id, name, description, created_at")
              .eq("id", portfolioId)
              .eq("user_id", userId)
              .single();

            if (pErr || !portfolio) {
              return { found: false, error: "Portfolio not found" };
            }

            const { data: holdings, error: hErr } = await supabase
              .from("portfolio_holdings")
              .select(
                `
                id,
                quantity,
                average_price,
                companies (symbol, name, current_price, change_percent)
              `
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
                  const currentPrice = company?.current_price as number ?? 0;
                  const avgPrice = h.average_price as number ?? 0;
                  const qty = h.quantity as number ?? 0;
                  return {
                    symbol: company?.symbol,
                    name: company?.name,
                    quantity: qty,
                    averagePrice: avgPrice,
                    currentPrice,
                    changePercent: company?.change_percent,
                    currentValue: currentPrice * qty,
                    gainLoss: (currentPrice - avgPrice) * qty,
                    gainLossPercent:
                      avgPrice > 0
                        ? ((currentPrice - avgPrice) / avgPrice) * 100
                        : null,
                  };
                }),
              },
            };
          } else {
            // Fetch all portfolios (summary only)
            const { data, error } = await supabase
              .from("portfolios")
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
        "Get the user's stock watchlist. Use this when the user asks about their watchlist, saved stocks, or stocks they're following.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { data, error } = await supabase
            .from("watchlist_items")
            .select(
              `
              id,
              created_at,
              companies (symbol, name, current_price, change_percent, change_points, sector)
            `
            )
            .eq("user_id", userId)
            .order("created_at", { ascending: false });

          if (error) {
            throw new Error(`Watchlist fetch failed: ${error.message}`);
          }

          return {
            watchlist: (data || []).map((item: Record<string, unknown>) => {
              const company = item.companies as Record<string, unknown> | null;
              return {
                symbol: company?.symbol,
                name: company?.name,
                price: company?.current_price,
                change: company?.change_points,
                changePercent: company?.change_percent,
                sector: company?.sector,
                addedAt: item.created_at,
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
  };
}
