/**
 * Mutual Funds Tools — FinasaanGPT
 * Flexible query tools for Pakistani mutual funds.
 * Tables: mutual_funds, mutual_fund_nav_history, fund_providers
 */

import { tool } from "ai";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";

export function createFundsTools(supabase: SupabaseClient) {
  return {
    queryMutualFunds: tool({
      description:
        "Query Pakistani mutual funds with flexible filters. Use this for any fund-related question: searching, filtering by category/risk, ranking by performance or size, or listing funds. Supports combining multiple filters.",
      inputSchema: z.object({
        search: z
          .string()
          .optional()
          .describe("Optional text search on fund name or symbol"),
        category: z
          .enum([
            "equity",
            "money_market",
            "income",
            "asset_allocation",
            "fund_of_funds",
            "islamic_equity",
            "islamic_income",
            "islamic_money_market",
            "all",
          ])
          .optional()
          .default("all")
          .describe(
            "Fund category filter. Use 'equity' for equity funds, 'money_market' for money market, etc.",
          ),
        riskProfile: z
          .enum(["low", "medium", "high", "all"])
          .optional()
          .default("all")
          .describe("Filter by risk level"),
        sortBy: z
          .enum(["ytd", "aum", "name"])
          .optional()
          .default("name")
          .describe(
            "Sort results by: ytd (year-to-date return %), aum (assets under management), or name",
          ),
        sortOrder: z
          .enum(["asc", "desc"])
          .optional()
          .default("desc")
          .describe(
            "Sort order. Default desc for ytd/aum (best first), asc for name (A-Z)",
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
      execute: async ({
        search,
        category,
        riskProfile,
        sortBy,
        sortOrder,
        limit,
      }) => {
        try {
          let query = supabase
            .from("mutual_funds")
            .select(
              "id, symbol, name, provider_id, sector_id, aum, ytd, risk_profile, description, inception_date",
            );

          // Text search filter
          if (search?.trim()) {
            query = query.or(`name.ilike.%${search}%,symbol.ilike.%${search}%`);
          }

          // Category filter: resolve sector_id from sectors table first
          if (category && category !== "all") {
            const categoryMap: Record<string, string> = {
              equity: "Equity",
              money_market: "Money Market",
              income: "Income",
              asset_allocation: "Asset Allocation",
              fund_of_funds: "Fund of Funds",
              islamic_equity: "Islamic Equity",
              islamic_income: "Islamic Income",
              islamic_money_market: "Islamic Money Market",
            };
            const sectorName = categoryMap[category];
            if (sectorName) {
              const { data: sector } = await supabase
                .from("sectors")
                .select("id")
                .ilike("name", `%${sectorName}%`)
                .single();

              if (sector) {
                query = query.eq("sector_id", sector.id);
              }
            }
          }

          // Risk profile filter
          if (riskProfile && riskProfile !== "all") {
            query = query.ilike("risk_profile", riskProfile);
          }

          // Sorting
          const effectiveSortBy = sortBy ?? "name";
          const effectiveSortOrder =
            sortOrder ?? (effectiveSortBy === "name" ? "asc" : "desc");

          if (effectiveSortBy === "ytd") {
            query = query
              .not("ytd", "is", null)
              .order("ytd", { ascending: effectiveSortOrder === "asc" });
          } else if (effectiveSortBy === "aum") {
            query = query
              .not("aum", "is", null)
              .order("aum", { ascending: effectiveSortOrder === "asc" });
          } else {
            query = query.order("name", {
              ascending: effectiveSortOrder === "asc",
            });
          }

          query = query.limit(limit ?? 10);

          const { data, error } = await query;

          if (error) {
            throw new Error(`Fund query failed: ${error.message}`);
          }

          return {
            filters: {
              search: search || null,
              category: category ?? "all",
              riskProfile: riskProfile ?? "all",
              sortBy: effectiveSortBy,
              sortOrder: effectiveSortOrder,
            },
            funds: (data || []).map((f: Record<string, unknown>) => ({
              id: f.id,
              symbol: f.symbol,
              name: f.name,
              providerId: f.provider_id,
              sectorId: f.sector_id,
              aum: f.aum,
              ytdReturn: f.ytd,
              riskProfile: f.risk_profile,
              description: f.description,
              inceptionDate: f.inception_date,
            })),
            total: (data || []).length,
          };
        } catch (err) {
          return {
            funds: [],
            total: 0,
            error: err instanceof Error ? err.message : "Fund query failed",
          };
        }
      },
    }),

    getFundDetail: tool({
      description:
        "Get full details about a specific mutual fund by ID or name. Use after queryMutualFunds to get complete info on a fund.",
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
            aum: f.aum,
            ytdReturn: f.ytd,
            riskProfile: f.risk_profile,
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

    getFundNavHistory: tool({
      description:
        "Get NAV (Net Asset Value) price history for a mutual fund. Use this to analyze fund performance trends, show price charts, or calculate returns over a period.",
      inputSchema: z.object({
        fundId: z
          .string()
          .describe("Fund UUID (get from queryMutualFunds or getFundDetail)"),
        days: z.coerce
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .default(30)
          .describe("Number of days of history to fetch (default 30, max 365)"),
      }),
      execute: async ({ fundId, days }) => {
        try {
          const { data, error } = await supabase
            .from("mutual_fund_nav_history")
            .select("nav_date, nav, offer_price, redemption_price")
            .eq("fund_id", fundId)
            .order("nav_date", { ascending: false })
            .limit(days ?? 30);

          if (error) {
            throw new Error(`NAV history fetch failed: ${error.message}`);
          }

          return {
            fundId,
            days: days ?? 30,
            history: (data || []).map((row: Record<string, unknown>) => ({
              date: row.nav_date,
              nav: row.nav,
              offerPrice: row.offer_price,
              redemptionPrice: row.redemption_price,
            })),
            total: (data || []).length,
          };
        } catch (err) {
          return {
            fundId,
            history: [],
            total: 0,
            error:
              err instanceof Error
                ? err.message
                : "Failed to fetch NAV history",
          };
        }
      },
    }),

    getFundProviders: tool({
      description:
        "Get list of all mutual fund management companies / providers (AMCs). Use when user asks about fund houses, AMCs, or management companies.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { data, error } = await supabase
            .from("fund_providers")
            .select("*")
            .order("name", { ascending: true });

          if (error) {
            throw new Error(`Providers fetch failed: ${error.message}`);
          }

          return {
            providers: data || [],
            total: (data || []).length,
          };
        } catch (err) {
          return {
            providers: [],
            total: 0,
            error:
              err instanceof Error
                ? err.message
                : "Failed to fetch fund providers",
          };
        }
      },
    }),
  };
}
