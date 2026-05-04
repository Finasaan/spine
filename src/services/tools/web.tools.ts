/**
 * Web Search Tools — FinasaanGPT
 * Serper.dev (Google Search) fallback for data not available in internal DB.
 * Last-resort only — internal tools always take priority.
 */

import { tool } from "ai";
import { z } from "zod";

const SERPER_SEARCH_URL = "https://google.serper.dev/search";

const FRESHNESS_MAP = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
} as const;

interface SerperOrganicResult {
  title: string;
  link: string;
  snippet?: string;
  date?: string;
  position?: number;
}

interface SerperKnowledgeGraph {
  title?: string;
  type?: string;
  website?: string;
  description?: string;
  descriptionSource?: string;
  descriptionLink?: string;
  attributes?: Record<string, string>;
}

interface SerperAnswerBox {
  title?: string;
  answer?: string;
  snippet?: string;
  link?: string;
}

interface SerperSearchResponse {
  knowledgeGraph?: SerperKnowledgeGraph;
  answerBox?: SerperAnswerBox;
  organic?: SerperOrganicResult[];
}

export function createWebTools(serperApiKey?: string) {
  return {
    webSearch: tool({
      description: `Google web search via Serper. Last in priority order — call internal tools first — but NOT optional: you MUST call this whenever your would-be answer is incomplete, stale, or only partially supported by internal data. Do not tell the user "I don't have that" without first trying webSearch. Required follow-up call after internal tools whenever the user asks for: current/intraday prices, "today's" anything, live ratios (P/E, P/B, dividend yield) computed off a live price, the latest quarterly or annual print, breaking news, current macro indicators (CPI, policy rate, FX), or any figure described as "current", "latest", or "now". Always retrieve the most current data possible: set recency='day' for intraday/live, 'week' for very recent moves, 'month' for recent earnings, 'year' for older context, omit for historical. Returns 'knowledgeGraph' (entity facts), 'answerBox' (Google's direct answer when available), and 'results' (organic snippets with URLs) — read knowledgeGraph and answerBox first, they are usually the highest-signal hit. ALWAYS cite the source URL inline and explicitly note the figure came from the web (not Finasaan's verified internal database). If web and internal data disagree, present both and flag the discrepancy.`,
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
        if (!serperApiKey) {
          return { error: "Web search is not configured (missing API key)." };
        }

        const body: Record<string, unknown> = {
          q: query,
          gl: "pk",
          hl: "en",
          num: 5,
        };

        if (recency) {
          body.tbs = FRESHNESS_MAP[recency];
        }

        try {
          const res = await fetch(SERPER_SEARCH_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-KEY": serperApiKey,
            },
            body: JSON.stringify(body),
          });

          if (!res.ok) {
            const text = await res.text().catch(() => "");
            return {
              error: `Serper Search returned ${res.status}: ${text.slice(0, 200)}`,
            };
          }

          const data = (await res.json()) as SerperSearchResponse;
          const organic = (data?.organic ?? []).slice(0, 5);

          const knowledgeGraph = data?.knowledgeGraph
            ? {
                title: data.knowledgeGraph.title ?? null,
                type: data.knowledgeGraph.type ?? null,
                website: data.knowledgeGraph.website ?? null,
                description: data.knowledgeGraph.description ?? null,
                source: data.knowledgeGraph.descriptionLink ?? null,
                attributes: data.knowledgeGraph.attributes ?? null,
              }
            : null;

          const answerBox = data?.answerBox
            ? {
                title: data.answerBox.title ?? null,
                answer: data.answerBox.answer ?? data.answerBox.snippet ?? null,
                link: data.answerBox.link ?? null,
              }
            : null;

          if (!organic.length && !knowledgeGraph && !answerBox) {
            return { results: [], message: "No web results found for this query." };
          }

          return {
            knowledgeGraph,
            answerBox,
            results: organic.map((r) => ({
              title: r.title,
              url: r.link,
              snippet: r.snippet ?? "",
              age: r.date ?? null,
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
