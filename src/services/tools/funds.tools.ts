/**
 * Mutual Funds Tools — FinasaanGPT
 * Flexible query tools for Pakistani mutual funds.
 * Tables: mutual_funds, mutual_fund_nav_history, fund_providers, sectors
 */

import { tool } from "ai";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";

export function createFundsTools(supabase: SupabaseClient) {
  return {
    queryMutualFunds: tool({
      description:
        "Query / rank Pakistani mutual funds with flexible filters. Use for ALL fund discovery and ranking questions: 'best equity fund over 3 years', 'largest Islamic income funds', 'low-risk money market funds', 'top YTD performers', or just listing funds by AMC. Combinable filters: search (text on name/symbol), category (equity | money_market | income | asset_allocation | fund_of_funds | islamic_equity | islamic_income | islamic_money_market), riskProfile (low | medium | high), providerId (AMC UUID — get via getFundProviders). sortBy: 'ytd' (year-to-date %), 'aum' (size), 'name', or 'return' (computed over returnPeriodMonths — 12=1yr, 36=3yr, 60=5yr — uses NAV history math). Returns symbol, name, AUM, YTD, risk profile, inception date, and (when sortBy='return') computed returnPct. For one named fund's full details use getFundDetail; for NAV charts use getFundNavHistory.",
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
            "Fund category filter. Use 'equity' for equity funds, 'money_market' for money market, 'islamic_equity' for Islamic equity, etc.",
          ),
        riskProfile: z
          .enum(["low", "medium", "high", "all"])
          .optional()
          .default("all")
          .describe("Filter by risk level"),
        providerId: z
          .string()
          .optional()
          .describe(
            "Filter by fund provider/AMC UUID (get from getFundProviders tool)",
          ),
        sortBy: z
          .enum(["ytd", "aum", "name", "return"])
          .optional()
          .default("name")
          .describe(
            "Sort results by: ytd (year-to-date %), aum (assets under management), name, or return (computed return over returnPeriodMonths)",
          ),
        returnPeriodMonths: z.coerce
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .default(12)
          .describe(
            "When sortBy is 'return', compute returns over this many months. E.g. 12 = 1 year, 36 = 3 years, 60 = 5 years. Default 12.",
          ),
        sortOrder: z
          .enum(["asc", "desc"])
          .optional()
          .default("desc")
          .describe(
            "Sort order. Default desc for ytd/aum/return (best first), asc for name (A-Z)",
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
        providerId,
        sortBy,
        returnPeriodMonths,
        sortOrder,
        limit,
      }) => {
        try {
          const effectiveSortBy = sortBy ?? "name";
          const effectiveSortOrder =
            sortOrder ?? (effectiveSortBy === "name" ? "asc" : "desc");
          const effectiveLimit = limit ?? 10;

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

          // Provider/AMC filter
          if (providerId) {
            query = query.eq("provider_id", providerId);
          }

          // Risk profile filter
          if (riskProfile && riskProfile !== "all") {
            query = query.ilike("risk_profile", riskProfile);
          }

          // --------------------------------------------------
          // If sorting by computed return, we need to fetch NAV
          // history and compute returns in JS
          // --------------------------------------------------
          if (effectiveSortBy === "return") {
            // Fetch a broader set of funds (up to 50) first, then rank
            const { data: funds, error: fundsErr } = await query.limit(50);

            if (fundsErr) {
              throw new Error(`Fund query failed: ${fundsErr.message}`);
            }

            if (!funds || funds.length === 0) {
              return { funds: [], total: 0 };
            }

            const months = returnPeriodMonths ?? 12;
            const startDate = new Date();
            startDate.setMonth(startDate.getMonth() - months);
            const startDateStr = startDate.toISOString().split("T")[0];

            const fundIds = funds.map(
              (f: Record<string, unknown>) => f.id as string,
            );

            // Get latest NAV for each fund
            const { data: latestNavs } = await supabase
              .from("mutual_fund_nav_history")
              .select("fund_id, nav_price, nav_date")
              .in("fund_id", fundIds)
              .order("nav_date", { ascending: false });

            // Get oldest NAV near the start date for each fund
            const { data: oldNavs } = await supabase
              .from("mutual_fund_nav_history")
              .select("fund_id, nav_price, nav_date")
              .in("fund_id", fundIds)
              .lte("nav_date", startDateStr)
              .order("nav_date", { ascending: false });

            // Build NAV lookup maps (first occurrence per fund = latest/closest)
            const latestNavMap = new Map<
              string,
              { nav: number; date: string }
            >();
            const oldNavMap = new Map<string, { nav: number; date: string }>();

            for (const row of (latestNavs || []) as Array<{
              fund_id: string;
              nav_price: number;
              nav_date: string;
            }>) {
              if (!latestNavMap.has(row.fund_id)) {
                latestNavMap.set(row.fund_id, {
                  nav: row.nav_price,
                  date: row.nav_date,
                });
              }
            }

            for (const row of (oldNavs || []) as Array<{
              fund_id: string;
              nav_price: number;
              nav_date: string;
            }>) {
              if (!oldNavMap.has(row.fund_id)) {
                oldNavMap.set(row.fund_id, {
                  nav: row.nav_price,
                  date: row.nav_date,
                });
              }
            }

            // Compute returns and attach to funds
            const fundsWithReturn = funds
              .map((f: Record<string, unknown>) => {
                const id = f.id as string;
                const latest = latestNavMap.get(id);
                const old = oldNavMap.get(id);

                let returnPct: number | null = null;
                if (latest && old && old.nav > 0) {
                  returnPct =
                    Math.round(((latest.nav - old.nav) / old.nav) * 100 * 100) /
                    100;
                }

                return {
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
                  returnPct,
                  returnPeriodMonths: months,
                  latestNav: latest?.nav ?? null,
                  latestNavDate: latest?.date ?? null,
                };
              })
              .filter((f: { returnPct: number | null }) => f.returnPct !== null)
              .sort(
                (
                  a: { returnPct: number | null },
                  b: { returnPct: number | null },
                ) =>
                  effectiveSortOrder === "desc"
                    ? (b.returnPct ?? 0) - (a.returnPct ?? 0)
                    : (a.returnPct ?? 0) - (b.returnPct ?? 0),
              )
              .slice(0, effectiveLimit);

            return {
              filters: {
                search: search || null,
                category: category ?? "all",
                riskProfile: riskProfile ?? "all",
                providerId: providerId || null,
                sortBy: "return",
                returnPeriodMonths: months,
                sortOrder: effectiveSortOrder,
              },
              funds: fundsWithReturn,
              total: fundsWithReturn.length,
            };
          }

          // --------------------------------------------------
          // Standard sorting (ytd, aum, name) — direct DB query
          // --------------------------------------------------
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

          query = query.limit(effectiveLimit);

          const { data, error } = await query;

          if (error) {
            throw new Error(`Fund query failed: ${error.message}`);
          }

          return {
            filters: {
              search: search || null,
              category: category ?? "all",
              riskProfile: riskProfile ?? "all",
              providerId: providerId || null,
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
        "Full record for ONE mutual fund — every column from mutual_funds (symbol, name, provider, sector, AUM, YTD, risk, description, inception). Pass fundId (UUID, preferred — usually obtained from queryMutualFunds) OR fundName (text — does an ilike fuzzy match, returns first hit). Use when the user names a specific fund or after queryMutualFunds when you need fields beyond the search projection. For NAV history / performance charts use getFundNavHistory.",
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
        "Daily NAV (Net Asset Value) price history for ONE mutual fund — used for performance trends, charts, and computing returns over a custom window. Requires fundId (UUID — get via queryMutualFunds or getFundDetail). 'days' sets the lookback (default 30, max 1825 = ~5 years). For ranked 'best fund over X years' use queryMutualFunds with sortBy='return' and returnPeriodMonths instead — it does the math across many funds in one call.",
      inputSchema: z.object({
        fundId: z
          .string()
          .describe("Fund UUID (get from queryMutualFunds or getFundDetail)"),
        days: z.coerce
          .number()
          .int()
          .min(1)
          .max(1825)
          .optional()
          .default(30)
          .describe(
            "Number of days of history to fetch (default 30, max 1825 = ~5 years)",
          ),
      }),
      execute: async ({ fundId, days }) => {
        try {
          const { data, error } = await supabase
            .from("mutual_fund_nav_history")
            .select("nav_date, nav_price")
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
              navPrice: row.nav_price,
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
        "List every Pakistani mutual fund management company (AMC) / fund provider with its UUID. Call this BEFORE queryMutualFunds whenever the user asks for funds from a specific house — e.g. 'HBL funds', 'Meezan AMC', 'UBL Fund Managers' → getFundProviders → pick the matching id → queryMutualFunds({providerId}).",
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
