/**
 * Mutual Funds Tools — FinasaanGPT
 * Queries for Pakistani mutual funds, NAVs, and AMC data.
 */

import { tool } from "ai";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";

export function createFundsTools(supabase: SupabaseClient) {
  return {
    searchMutualFunds: tool({
      description:
        "Search for Pakistani mutual funds by name, AMC (Asset Management Company), or fund type. Use this when the user asks about mutual funds, investment funds, or specific AMCs like Meezan, NBP Funds, UBL, etc.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Fund name, AMC name, or fund type to search for (e.g. 'Meezan', 'equity', 'money market')"
          ),
        fundType: z
          .string()
          .optional()
          .describe(
            "Filter by fund type: 'equity', 'money market', 'income', 'balanced', 'islamic', etc."
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe("Maximum number of results"),
      }),
      execute: async ({ query, fundType, limit }) => {
        try {
          let dbQuery = supabase
            .from("mutual_funds")
            .select(
              "id, name, amc, fund_type, nav, nav_date, aum, return_1y, return_3y, is_etf, is_debt"
            )
            .or(`name.ilike.%${query}%,amc.ilike.%${query}%`);

          if (fundType) {
            dbQuery = dbQuery.ilike("fund_type", `%${fundType}%`);
          }

          const { data, error } = await dbQuery
            .order("aum", { ascending: false, nullsFirst: false })
            .limit(limit ?? 10);

          if (error) {
            throw new Error(`Fund search failed: ${error.message}`);
          }

          return {
            query,
            fundType: fundType ?? null,
            funds: (data || []).map((f: Record<string, unknown>) => ({
              id: f.id,
              name: f.name,
              amc: f.amc,
              fundType: f.fund_type,
              nav: f.nav,
              navDate: f.nav_date,
              aum: f.aum,
              return1y: f.return_1y,
              return3y: f.return_3y,
              isETF: f.is_etf,
              isDebt: f.is_debt,
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
        "Get detailed information about a specific mutual fund by its ID or exact name, including NAV history and performance metrics.",
      inputSchema: z.object({
        fundId: z
          .string()
          .optional()
          .describe("The fund's UUID from a previous search"),
        fundName: z
          .string()
          .optional()
          .describe("The exact fund name if ID is not available"),
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
            name: f.name,
            amc: f.amc,
            fundType: f.fund_type,
            nav: f.nav,
            navDate: f.nav_date,
            aum: f.aum,
            return1y: f.return_1y,
            return3y: f.return_3y,
            return5y: f.return_5y,
            managementFee: f.management_fee,
            isETF: f.is_etf,
            isDebt: f.is_debt,
            isIslamic: f.is_islamic,
            riskLevel: f.risk_level,
          };
        } catch (err) {
          return {
            found: false,
            error: err instanceof Error ? err.message : "Failed to fetch fund details",
          };
        }
      },
    }),

    getTopFunds: tool({
      description:
        "Get a ranked list of top mutual funds by returns or AUM. Use this when asked for best-performing funds, highest-return funds, or largest funds.",
      inputSchema: z.object({
        sortBy: z
          .enum(["return_1y", "return_3y", "aum", "nav"])
          .optional()
          .default("return_1y")
          .describe(
            "Sort funds by: 'return_1y' (1-year returns), 'return_3y' (3-year returns), 'aum' (fund size)"
          ),
        fundType: z
          .string()
          .optional()
          .describe("Filter by fund type (e.g. 'equity', 'money market')"),
        isIslamic: z
          .boolean()
          .optional()
          .describe("Filter to Islamic (Shariah-compliant) funds only"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe("Number of funds to return"),
      }),
      execute: async ({ sortBy, fundType, isIslamic, limit }) => {
        try {
          let dbQuery = supabase
            .from("mutual_funds")
            .select(
              "id, name, amc, fund_type, nav, aum, return_1y, return_3y, is_etf, is_debt"
            );

          if (fundType) {
            dbQuery = dbQuery.ilike("fund_type", `%${fundType}%`);
          }

          if (isIslamic === true) {
            dbQuery = dbQuery.eq("is_islamic", true);
          }

          const { data, error } = await dbQuery
            .not(sortBy ?? "return_1y", "is", null)
            .order(sortBy ?? "return_1y", {
              ascending: false,
              nullsFirst: false,
            })
            .limit(limit ?? 10);

          if (error) {
            throw new Error(`Top funds fetch failed: ${error.message}`);
          }

          return {
            sortBy: sortBy ?? "return_1y",
            fundType: fundType ?? null,
            isIslamic: isIslamic ?? null,
            funds: (data || []).map((f: Record<string, unknown>) => ({
              id: f.id,
              name: f.name,
              amc: f.amc,
              fundType: f.fund_type,
              nav: f.nav,
              aum: f.aum,
              return1y: f.return_1y,
              return3y: f.return_3y,
            })),
            total: (data || []).length,
          };
        } catch (err) {
          return {
            sortBy: sortBy ?? "return_1y",
            funds: [],
            total: 0,
            error: err instanceof Error ? err.message : "Failed to fetch top funds",
          };
        }
      },
    }),
  };
}
