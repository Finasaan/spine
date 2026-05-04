/**
 * Web Search Tools — FinasaanGPT
 * Brave Search fallback for data not available in internal DB.
 * Last-resort only — internal tools always take priority.
 */

import { tool } from "ai";
import { z } from "zod";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

const FRESHNESS_MAP = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
} as const;

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  age?: string;
  page_age?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export function createWebTools(braveApiKey?: string) {
  return {
    webSearch: tool({
      description: `Brave Search over the public web. LAST RESORT ONLY — call this strictly AFTER all relevant internal tools have come back empty (queryFinancialTables tables AND fallbackResults empty, searchKnowledge empty, getStockDetail/getStockHistory/getRecentHeadlines/searchRecentNews/searchTaxDocs all insufficient). Good for: live P/E or other live ratios not stored in DB, very recent quarterly results not yet ingested, current KSE-100 levels intraday, Pakistan macro indicators, breaking news Finasaan has not yet pulled. Use 'recency' to bound the time window: 'day'/'week' for live market data, 'month' for recent earnings, 'year' for older context, omit for historical. ALWAYS cite the source URL in your response and explicitly note the data is from the web (not Finasaan's verified internal database).`,
      inputSchema: z.object({
        query: z.string().describe(
          "Specific search query. Include company name/ticker and the exact metric needed. E.g. 'OGDC Pakistan P/E ratio 2025', 'KSE-100 index today', 'HBL earnings Q1 2025 Pakistan'."
        ),
        recency: z
          .enum(["day", "week", "month", "year"])
          .optional()
          .describe(
            "Limit results to this time window. Use 'day' or 'week' for live prices and market data. Use 'month' for recent earnings or reports. Omit for historical or general context."
          ),
      }),
      execute: async ({ query, recency }) => {
        if (!braveApiKey) {
          return { error: "Web search is not configured (missing API key)." };
        }

        const params = new URLSearchParams({
          q: query,
          count: "5",
          search_lang: "en",
          safesearch: "moderate",
        });

        if (recency) {
          params.set("freshness", FRESHNESS_MAP[recency]);
        }

        try {
          const res = await fetch(`${BRAVE_SEARCH_URL}?${params.toString()}`, {
            headers: {
              Accept: "application/json",
              "Accept-Encoding": "gzip",
              "X-Subscription-Token": braveApiKey,
            },
          });

          if (!res.ok) {
            const body = await res.text().catch(() => "");
            return {
              error: `Brave Search returned ${res.status}: ${body.slice(0, 200)}`,
            };
          }

          const data = (await res.json()) as BraveSearchResponse;
          const results = (data?.web?.results ?? []).slice(0, 5);

          if (!results.length) {
            return { results: [], message: "No web results found for this query." };
          }

          return {
            results: results.map((r) => ({
              title: r.title,
              url: r.url,
              snippet: r.description ?? "",
              age: r.age ?? r.page_age ?? null,
            })),
          };
        } catch (err) {
          return {
            error: `Web search failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    }),
  };
}
