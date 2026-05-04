/**
 * Knowledge Tools — FinasaanGPT
 * Semantic RAG search over finasaan_documents, conversation_document_chunks,
 * and structured financial tables from extracted_tables.
 */

import { tool } from "ai";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";
import { generateEmbedding } from "../ai.service";

// ============================================================================
// Company Name Resolution Helper
// ============================================================================

/**
 * Resolve a user-provided company name or ticker to a set of search terms.
 * Queries the `companies` table to find matching symbols and names,
 * so "NPL" resolves to ["NPL", "Nishat Power Limited"] and vice versa.
 *
 * Returns an array of unique ilike patterns to OR together.
 */
async function resolveCompanyNames(
  supabase: SupabaseClient,
  input: string,
): Promise<string[]> {
  const terms = new Set<string>();
  terms.add(input);

  // Strip common suffixes/parenthetical tickers for broader matching
  const cleaned = input
    .replace(/\s*\(.*?\)\s*/g, "") // Remove parenthetical like "(NPL)"
    .replace(/\s+(limited|ltd|plc|inc)\.?$/i, "") // Remove corporate suffixes
    .trim();
  if (cleaned && cleaned !== input) terms.add(cleaned);

  // Extract ticker from parenthetical if present, e.g. "Nishat Power (NPL)" → "NPL"
  const tickerMatch = input.match(/\(([A-Z0-9]+)\)/);
  if (tickerMatch) terms.add(tickerMatch[1]);

  // Sanitize a term for use in PostgREST .or() filter values
  const sanitize = (s: string) => s.replace(/[,.:()\\"]/g, "");

  try {
    // Search companies table for matches on any of our terms
    const orClauses = Array.from(terms)
      .flatMap((t) => {
        const safe = sanitize(t);
        return [
          `symbol.ilike."%${safe}%"`,
          `company_name.ilike."%${safe}%"`,
        ];
      })
      .join(",");

    const { data } = await supabase
      .from("companies")
      .select("symbol, company_name")
      .or(orClauses)
      .limit(5);

    if (data) {
      for (const row of data) {
        if (row.symbol) terms.add(row.symbol as string);
        if (row.company_name) terms.add(row.company_name as string);
      }
    }
  } catch {
    // Non-fatal — proceed with whatever terms we have
  }

  return Array.from(terms);
}

// ============================================================================
// Tool Factory
// ============================================================================

export function createKnowledgeTools(
  supabase: SupabaseClient,
  ai: Ai,
  sessionId: string,
  env?: { CLOUDFLARE_ACCOUNT_ID?: string; CLOUDFLARE_API_TOKEN?: string }
) {

  return {
    searchKnowledge: tool({
      description:
        "Semantic search over the ingested knowledge base (finasaan_documents) — annual/quarterly report prose, insurance policy documents, mutual-fund factsheets, financial-literacy content, regulatory material. PRIMARY tool for: (a) qualitative content — management commentary, report notes, policy details, regulatory context; (b) ALL insurance product/policy/comparison questions. SECONDARY / FALLBACK tool for specific financial figures: only call this for revenue/profit/balance-sheet/cash-flow/ratio numbers AFTER queryFinancialTables has returned with both 'tables' and 'fallbackResults' empty. Pass domain ('financials' | 'insurance' | 'mutual_funds' | 'all') and optionally company/period filters — auto-resolves company name variations (e.g. 'Nishat Power' ↔ 'NPL').",
      inputSchema: z.object({
        query: z.string().describe("Search query string"),
        domain: z
          .enum(["financials", "insurance", "mutual_funds", "all"])
          .optional()
          .default("all")
          .describe(
            "Domain filter: financials, insurance, mutual_funds, or all",
          ),
        company: z
          .string()
          .optional()
          .describe(
            "Company name or ticker to filter results by (e.g. 'PTCL', 'Meezan Bank', 'HBL'). Matches against document metadata. When provided, only documents tagged with this company are returned.",
          ),
        period: z
          .string()
          .optional()
          .describe(
            "Fiscal period to filter by (e.g. 'Q1 2026', '2025', 'FY 2024'). Matches against document metadata.",
          ),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .default(5)
          .describe("Number of results"),
      }),
      execute: async ({ query, domain, company, period, limit }) => {
        try {
          // Resolve company name variants for metadata matching
          let companyFilter: string | null = null;
          if (company?.trim()) {
            const names = await resolveCompanyNames(supabase, company.trim());
            // Use the longest resolved name for best metadata match
            companyFilter = names.reduce((a, b) => a.length > b.length ? a : b, names[0]);
          }

          const embedding = await generateEmbedding(ai, query, env);
          const vectorStr = JSON.stringify(embedding);

          const { data, error } = await supabase.rpc(
            "search_finasaan_documents",
            {
              query_embedding: vectorStr,
              match_limit: limit ?? 5,
              filter_domain: domain === "all" ? null : (domain ?? null),
              min_similarity: 0.35,
              filter_company: companyFilter,
              filter_period: period?.trim() || null,
            },
          );

          if (error) {
            throw new Error(`Knowledge search failed: ${error.message}`);
          }

          const results = (data || []) as Array<{
            id: number;
            domain: string;
            content: string;
            metadata: Record<string, unknown>;
            source_url: string | null;
            similarity: number;
          }>;

          return {
            query,
            domain: domain ?? "all",
            company: companyFilter,
            period: period || null,
            results: results.map((r) => ({
              id: r.id,
              domain: r.domain,
              content: r.content,
              metadata: r.metadata,
              similarity: Math.round(r.similarity * 1000) / 1000,
            })),
            total: results.length,
          };
        } catch (err) {
          return {
            query,
            domain: domain ?? "all",
            company: company || null,
            period: period || null,
            results: [],
            total: 0,
            error: err instanceof Error ? err.message : "Search failed",
          };
        }
      },
    }),

    searchTaxDocs: tool({
      description:
        "Semantic search over the canonical Pakistan tax corpus: Income Tax Ordinance, Income Tax Rules, and FBR Circulars. ALWAYS use this — never searchKnowledge or webSearch — for ANY taxation question: salary/business/property tax slabs, withholding rates, exemptions, allowable deductions/credits (e.g. pension fund credit), tax-filing procedures, FBR notifications, ordinance section lookups. Filter by docType ('ordinance' | 'rules' | 'circular' | 'all'). Returns chunks with the official source name and URL — always cite these.",
      inputSchema: z.object({
        query: z.string().describe("Search query string (e.g. 'tax slabs for salary', 'pension fund tax credit')"),
        docType: z.enum(["ordinance", "rules", "circular", "all"]).optional().default("all").describe("Filter by document type"),
        limit: z.coerce.number().int().min(1).max(10).optional().default(5).describe("Number of chunks to retrieve"),
      }),
      execute: async ({ query, docType, limit }) => {
        try {
          const embedding = await generateEmbedding(ai, query, env);
          const { data, error } = await supabase.rpc("search_tax_chunks", {
            query_embedding: JSON.stringify(embedding),
            match_limit:     limit ?? 5,
            filter_doc_type: docType === "all" ? null : docType,
          });

          if (error) throw new Error(`Tax search failed: ${error.message}`);

          const results = (data || []) as Array<{
            id: string;
            text: string;
            source_name: string;
            doc_type: string;
            source_url: string;
            similarity: number;
          }>;

          return {
            query,
            results: results.map((r) => ({
              text: r.text,
              source: r.source_name,
              type: r.doc_type,
              url: r.source_url,
              similarity: Math.round(r.similarity * 1000) / 1000,
            })),
            total: results.length,
          };
        } catch (err) {
          return {
            query,
            results: [],
            total: 0,
            error: err instanceof Error ? err.message : "Tax search failed",
          };
        }
      },
    }),

    queryFinancialTables: tool({
      description:
        "PRIMARY tool for ANY specific financial figure from a Pakistani listed company's reports — revenue, gross/operating/net profit, EBITDA, EPS, total assets, equity, liabilities, cash flows, segment data, key ratios, etc. Returns structured rows (headers + data) from extracted_tables — categorised as income_statement, balance_sheet, cash_flow, key_metrics, segment_data, fund_portfolio, premium_schedule, coverage_table, rate_table, or general. Auto-resolves company names ↔ tickers (e.g. 'HBL' ↔ 'Habib Bank Limited'). IMPORTANT FALLBACK BEHAVIOR: if no structured tables are tagged for that company/period, the response replaces 'tables' with a 'fallbackResults' array containing ingested-document chunks tagged with this company/period — treat those chunks as authoritative source material and answer from them. Only escalate to searchKnowledge when BOTH 'tables' and 'fallbackResults' come back empty. Always call this BEFORE searchKnowledge for numeric/figure questions.",
      inputSchema: z.object({
        company: z
          .string()
          .optional()
          .describe(
            "Company name or PSX ticker symbol (e.g. 'NPL', 'Nishat Power', 'HBL'). Partial matches work.",
          ),
        tableType: z
          .enum([
            "income_statement",
            "balance_sheet",
            "cash_flow",
            "key_metrics",
            "segment_data",
            "fund_portfolio",
            "premium_schedule",
            "coverage_table",
            "rate_table",
            "general",
            "all",
          ])
          .optional()
          .default("all")
          .describe("Filter by table type, or 'all' for any type"),
        fiscalPeriod: z
          .string()
          .optional()
          .describe(
            "Fiscal period filter (e.g. '2024', '2023', 'Q3 2024', '2024-06-30')",
          ),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .default(5)
          .describe("Max tables to return"),
      }),
      execute: async ({ company, tableType, fiscalPeriod, limit }) => {
        try {
          let query = supabase
            .from("extracted_tables")
            .select(
              "id, company_name, company_id, table_name, table_type, " +
                "fiscal_period, fiscal_period_end, currency, table_unit, " +
                "comparative, headers, rows, source_type, created_at",
            )
            .order("created_at", { ascending: false })
            .limit(limit ?? 5);

          // Company filter with automatic name resolution
          let resolvedCompanyName: string | null = null;
          if (company?.trim()) {
            const names = await resolveCompanyNames(supabase, company.trim());
            resolvedCompanyName = names.reduce((a, b) => a.length > b.length ? a : b, names[0]);
            // Sanitize for PostgREST .or() reserved characters
            const sanitize = (s: string) => s.replace(/[,.:()\\"]/g, "");
            const orClauses = names
              .flatMap((n) => {
                const safe = sanitize(n);
                return [
                  `company_name.ilike."%${safe}%"`,
                  `company_id.ilike."%${safe}%"`,
                ];
              })
              .join(",");
            query = query.or(orClauses);
          }

          // Table type filter
          if (tableType && tableType !== "all") {
            query = query.eq("table_type", tableType);
          }

          // Fiscal period filter (partial match on TEXT column)
          if (fiscalPeriod?.trim()) {
            const fp = fiscalPeriod.trim();
            query = query.ilike("fiscal_period", `%${fp}%`);
          }

          const { data, error } = await query;

          if (error) {
            throw new Error(
              `Financial tables query failed: ${error.message}`,
            );
          }

          const tables = (data || []) as Array<Record<string, unknown>>;

          // --- SMART FALLBACK ---
          // If no structured tables, fetch ingested-document chunks tagged with
          // the same company (and optional period) directly from finasaan_documents.
          // Bypasses semantic ranking — when the caller has already specified
          // company+period, metadata equality is the right tool, not similarity.
          if (tables.length === 0 && resolvedCompanyName) {
            const trimmedPeriod = fiscalPeriod?.trim();

            let q = supabase
              .from("finasaan_documents")
              .select("content, metadata, source_url")
              .eq("domain", "financials")
              .filter("metadata->>company", "ilike", `%${resolvedCompanyName}%`);

            if (trimmedPeriod) {
              q = q.filter("metadata->>period", "ilike", `%${trimmedPeriod}%`);
            }

            const { data: kbData, error: kbError } = await q
              .order("id", { ascending: false })
              .limit(limit ?? 5);

            if (!kbError && kbData && kbData.length > 0) {
              return {
                company: company || null,
                tableType: tableType ?? "all",
                fiscalPeriod: fiscalPeriod || null,
                fallbackResults: (kbData as Array<Record<string, unknown>>).map(
                  (r) => ({
                    content: r.content,
                    metadata: r.metadata,
                  }),
                ),
                note: "No structured tables found. Returning ingested-document chunks tagged with this company/period from the knowledge base.",
                total: kbData.length,
              };
            }
          }

          return {
            company: company || null,
            tableType: tableType ?? "all",
            fiscalPeriod: fiscalPeriod || null,
            tables: tables.map((t) => ({
              id: t.id,
              companyName: t.company_name,
              companyId: t.company_id,
              tableName: t.table_name,
              tableType: t.table_type,
              fiscalPeriod: t.fiscal_period,
              fiscalPeriodEnd: t.fiscal_period_end,
              currency: t.currency,
              tableUnit: t.table_unit,
              comparative: t.comparative,
              headers: t.headers,
              rows: t.rows,
              sourceType: t.source_type,
            })),
            total: tables.length,
          };
        } catch (err) {
          return {
            company: company || null,
            tableType: tableType ?? "all",
            fiscalPeriod: fiscalPeriod || null,
            tables: [],
            total: 0,
            error:
              err instanceof Error
                ? err.message
                : "Financial tables query failed",
          };
        }
      },
    }),

    searchConversationDocument: tool({
      description:
        "Semantic search restricted to files the user uploaded into THIS conversation (PDF/document attachments). ALWAYS use this — and use it FIRST, before any other knowledge tool — when the user references 'this document', 'the file I just uploaded', 'this PDF', or asks questions whose answers would only be in their attached file. Scoped to the current sessionId, so it never leaks other users' uploads or the global knowledge base. If the answer requires both the user's upload and general data (e.g. 'compare what's in this PDF to HBL's actual Q1 numbers'), call this first, then call queryFinancialTables / searchKnowledge.",
      inputSchema: z.object({
        query: z.string().describe("Search query string"),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .default(4)
          .describe("Number of chunks to retrieve"),
      }),
      execute: async ({ query, limit }) => {
        try {
          const embedding = await generateEmbedding(ai, query);
          const vectorStr = JSON.stringify(embedding);

          const { data, error } = await supabase.rpc(
            "search_conversation_chunks",
            {
              query_embedding: vectorStr,
              p_session_id: sessionId,
              match_limit: limit ?? 4,
              min_similarity: 0.4,
            },
          );

          if (error) {
            throw new Error(`Document search failed: ${error.message}`);
          }

          const results = (data || []) as Array<{
            id: number;
            filename: string;
            chunk_index: number;
            content: string;
            similarity: number;
          }>;

          return {
            query,
            sessionId,
            results: results.map((r) => ({
              filename: r.filename,
              chunk_index: r.chunk_index,
              content: r.content,
              similarity: Math.round(r.similarity * 1000) / 1000,
            })),
            total: results.length,
          };
        } catch (err) {
          return {
            query,
            sessionId,
            results: [],
            total: 0,
            error: err instanceof Error ? err.message : "Document search failed",
          };
        }
      },
    }),

    getRecentHeadlines: tool({
      description:
        "Browse the latest Pakistan economic/business news from ingested sources (Dawn Business, Profit Pakistan Today, Tribune Business). Use for OPEN-ENDED 'what's happening' style questions where the user has NOT named a specific topic, company, or sector. Each article ships with an AI summary, sentiment tag (positive/negative/neutral), affected sectors, affected tickers, and impact analysis — surface these in your response. Optional filters: sentiment, sector. For topic/company/ticker-specific news, use searchRecentNews instead.",
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(10).optional().default(5)
          .describe("Number of articles to return"),
        sentiment: z
          .enum(["positive", "negative", "neutral", "all"])
          .optional()
          .default("all")
          .describe("Filter by market sentiment"),
        sector: z.string().optional()
          .describe("Filter by affected sector (e.g. 'Banking', 'Oil & Gas')"),
      }),
      execute: async ({ limit, sentiment, sector }) => {
        try {
          let query = supabase
            .from("economic_news")
            .select(
              "id, title, url, source, published_at, ai_summary, sentiment, " +
              "affected_sectors, affected_tickers, impact_analysis"
            )
            .order("published_at", { ascending: false })
            .limit(limit ?? 5);

          if (sentiment && sentiment !== "all") {
            query = query.eq("sentiment", sentiment);
          }
          if (sector) {
            query = query.contains("affected_sectors", [sector]);
          }

          const { data, error } = await query;
          if (error) throw new Error(error.message);

          return {
            articles: data ?? [],
            total:    (data ?? []).length,
            note:     "Articles ordered most recent first.",
          };
        } catch (err) {
          return {
            articles: [],
            total:    0,
            error:    err instanceof Error ? err.message : "Failed to fetch headlines",
          };
        }
      },
    }),

    searchRecentNews: tool({
      description:
        "Targeted search of recent Pakistan economic/business news by TOPIC, COMPANY, TICKER, SECTOR, or EVENT. Use whenever the user asks about news on something specific — 'news on HBL', 'OGDC announcements', 'banking sector news', 'IMF deal updates'. Internally tries vector similarity search first (default min similarity 0.40), then falls back to recency-ordered articles. Default 30-day window, max 90 days. Returns same enriched fields as getRecentHeadlines (summary, sentiment, affected_sectors, affected_tickers, impact_analysis). For broad 'what's happening' without a target, use getRecentHeadlines.",
      inputSchema: z.object({
        query:        z.string().describe("Natural language search query or company/ticker name"),
        limit:        z.coerce.number().int().min(1).max(8).optional().default(5).describe("Results to return"),
        max_age_days: z.coerce.number().int().min(1).max(90).optional().default(30).describe("Only search articles from last N days"),
      }),
      execute: async ({ query, limit, max_age_days }) => {
        const effectiveLimit = limit ?? 5;
        const effectiveDays  = max_age_days ?? 30;

        // --- Attempt 1: vector similarity search ---
        try {
          const embedding = await generateEmbedding(ai, query, env);
          const { data, error } = await supabase.rpc("search_economic_news", {
            query_embedding: JSON.stringify(embedding),
            match_limit:     effectiveLimit,
            min_similarity:  0.40,
            max_age_days:    effectiveDays,
          });

          if (!error && (data ?? []).length > 0) {
            const results = data as Array<{
              id: string; title: string; url: string; source: string;
              published_at: string; ai_summary: string; sentiment: string;
              affected_sectors: string[]; affected_tickers: string[];
              impact_analysis: string; similarity: number;
            }>;
            return {
              query,
              articles: results.map((r) => ({ ...r, similarity: Math.round(r.similarity * 1000) / 1000 })),
              total:    results.length,
            };
          }
        } catch {
          // fall through to text search
        }

        // --- Attempt 2: return all recent articles, let the model filter ---
        try {
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - effectiveDays);

          const { data, error } = await supabase
            .from("economic_news")
            .select(
              "id, title, url, source, published_at, ai_summary, sentiment, " +
              "affected_sectors, affected_tickers, impact_analysis"
            )
            .gte("published_at", cutoff.toISOString())
            .order("published_at", { ascending: false })
            .limit(effectiveLimit);

          if (error) throw new Error(error.message);

          return {
            query,
            articles: (data ?? []) as Array<{
              id: string; title: string; url: string; source: string;
              published_at: string; ai_summary: string; sentiment: string;
              affected_sectors: string[]; affected_tickers: string[];
              impact_analysis: string;
            }>,
            total: (data ?? []).length,
          };
        } catch (err) {
          return {
            query,
            articles: [],
            total:    0,
            error:    err instanceof Error ? err.message : "News search failed",
          };
        }
      },
    }),
  };
}

