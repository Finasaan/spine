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
// Fiscal Period Normalization
// ============================================================================

/**
 * Generate equivalent fiscal-period strings for ilike matching.
 * Stored values vary wildly across the corpus:
 *   extracted_tables.fiscal_period: "2026-03", "2024-06-30", "2024-12-31"
 *   finasaan_documents.metadata.period: "Q1 2026", "Q12026", "FY2025", "Q4 2024"
 * A user/model query like "Q1 2026" must match all of these forms.
 *
 * Pakistani listed companies use a calendar fiscal year (Jan–Dec) by default,
 * so Q1 ends Mar-31, Q2 Jun-30, Q3 Sep-30, Q4 Dec-31.
 */
function fiscalPeriodVariants(input: string): string[] {
  const out = new Set<string>();
  const trimmed = input.trim();
  if (!trimmed) return [];
  out.add(trimmed);
  out.add(trimmed.replace(/\s+/g, ""));

  const monthByQuarter: Record<number, string> = { 1: "03", 2: "06", 3: "09", 4: "12" };
  const dayByQuarter: Record<number, string> = { 1: "31", 2: "30", 3: "30", 4: "31" };
  const quarterByMonth: Record<number, number> = { 3: 1, 6: 2, 9: 3, 12: 4 };

  // "Q1 2026", "Q1FY26", "Q1 FY 2026", etc → ISO month + alt forms
  const qMatch = trimmed.match(/^Q\s*([1-4])\s*(?:FY\s*)?(\d{2,4})$/i);
  if (qMatch) {
    const q = parseInt(qMatch[1], 10);
    const yr = qMatch[2].length === 2 ? "20" + qMatch[2] : qMatch[2];
    const yr2 = yr.slice(-2);
    out.add(`${yr}-${monthByQuarter[q]}`);
    out.add(`${yr}-${monthByQuarter[q]}-${dayByQuarter[q]}`);
    out.add(`Q${q} ${yr}`);
    out.add(`Q${q}${yr}`);
    out.add(`Q${q} FY${yr2}`);
    out.add(`Q${q}FY${yr2}`);
  }

  // "2026-03", "2026-03-31" → quarter forms
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (isoMatch) {
    const yr = isoMatch[1];
    const month = parseInt(isoMatch[2], 10);
    const q = quarterByMonth[month];
    if (q) {
      out.add(`Q${q} ${yr}`);
      out.add(`Q${q}${yr}`);
      out.add(`${yr}-${isoMatch[2]}`);
    }
  }

  // "FY2025", "FY 2025", "2025" → all year forms
  const yMatch = trimmed.match(/^(?:FY\s*)?(\d{4})$/i);
  if (yMatch) {
    const yr = yMatch[1];
    out.add(yr);
    out.add(`FY${yr}`);
    out.add(`FY ${yr}`);
  }

  return Array.from(out);
}

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

          // Fiscal period filter — OR across normalized variants so "Q1 2026"
          // matches stored ISO forms like "2026-03", and "2025" matches "FY2025".
          const periodVariants = fiscalPeriod?.trim()
            ? fiscalPeriodVariants(fiscalPeriod.trim())
            : [];
          if (periodVariants.length > 0) {
            const sanitize = (s: string) => s.replace(/[,()\\"]/g, "");
            const periodOr = periodVariants
              .map((v) => `fiscal_period.ilike."%${sanitize(v)}%"`)
              .join(",");
            query = query.or(periodOr);
          }

          const { data, error } = await query;

          if (error) {
            throw new Error(
              `Financial tables query failed: ${error.message}`,
            );
          }

          let tables = (data || []) as Array<Record<string, unknown>>;
          let periodNote: string | null = null;

          // No-period retry: if a period filter zeroed out the result but the
          // company has data in other periods, return those rows with a note
          // so the model can either answer from a nearby period or tell the
          // user explicitly which periods we have.
          if (tables.length === 0 && periodVariants.length > 0 && resolvedCompanyName) {
            let retry = supabase
              .from("extracted_tables")
              .select(
                "id, company_name, company_id, table_name, table_type, " +
                  "fiscal_period, fiscal_period_end, currency, table_unit, " +
                  "comparative, headers, rows, source_type, created_at",
              )
              .order("created_at", { ascending: false })
              .limit(limit ?? 5);

            if (company?.trim()) {
              const names = await resolveCompanyNames(supabase, company.trim());
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
              retry = retry.or(orClauses);
            }
            if (tableType && tableType !== "all") {
              retry = retry.eq("table_type", tableType);
            }

            const { data: retryData } = await retry;
            const retryRows = (retryData || []) as Array<Record<string, unknown>>;
            if (retryRows.length > 0) {
              const periodsAvailable = Array.from(
                new Set(retryRows.map((r) => r.fiscal_period).filter(Boolean) as string[])
              );
              periodNote =
                `No tables found for "${fiscalPeriod}". Returning all available periods for this company. ` +
                `Periods available: ${periodsAvailable.join(", ")}.`;
              tables = retryRows;
            }
          }

          // --- SMART FALLBACK ---
          // If no structured tables, fetch ingested-document chunks tagged with
          // the same company (and optional period) directly from finasaan_documents.
          // OR's across ALL resolved company-name variants — single longest term
          // misses "HBL"-style queries when only "Habib Bank Limited" is stored.
          if (tables.length === 0 && company?.trim()) {
            const names = await resolveCompanyNames(supabase, company.trim());
            const sanitize = (s: string) => s.replace(/[,()\\"]/g, "");

            const tryFallback = async (usePeriod: boolean) => {
              let q = supabase
                .from("finasaan_documents")
                .select("content, metadata, source_url")
                .eq("domain", "financials");

              const nameOr = names
                .map((n) => `metadata->>company.ilike."%${sanitize(n)}%"`)
                .join(",");
              q = q.or(nameOr);

              if (usePeriod && periodVariants.length > 0) {
                const periodOr = periodVariants
                  .map((v) => `metadata->>period.ilike."%${sanitize(v)}%"`)
                  .join(",");
                q = q.or(periodOr);
              }

              const { data: kbData, error: kbError } = await q
                .order("id", { ascending: false })
                .limit(limit ?? 5);
              return { kbData: kbData || [], kbError };
            };

            // Pass 1: company + period. Pass 2: company only.
            let { kbData, kbError } = await tryFallback(true);
            let kbNote =
              "No structured tables found. Returning ingested-document chunks tagged with this company/period from the knowledge base.";
            if (!kbError && kbData.length === 0 && periodVariants.length > 0) {
              const r2 = await tryFallback(false);
              kbData = r2.kbData;
              kbError = r2.kbError;
              if (!kbError && kbData.length > 0) {
                const periodsSeen = Array.from(
                  new Set(
                    (kbData as Array<Record<string, unknown>>)
                      .map((r) => (r.metadata as Record<string, unknown> | null)?.period)
                      .filter(Boolean) as string[],
                  ),
                );
                kbNote =
                  `No structured tables or document chunks for "${fiscalPeriod}". ` +
                  `Returning chunks for this company across all periods. ` +
                  `Periods available: ${periodsSeen.join(", ") || "(unspecified)"}.`;
              }
            }

            if (!kbError && kbData.length > 0) {
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
                note: kbNote,
                total: kbData.length,
              };
            }
          }

          return {
            company: company || null,
            tableType: tableType ?? "all",
            fiscalPeriod: fiscalPeriod || null,
            ...(periodNote ? { note: periodNote } : {}),
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
        "Targeted search of recent Pakistan economic/business news by TOPIC, COMPANY, TICKER, SECTOR, or EVENT. Use whenever the user asks about news on something specific — 'news on HBL', 'OGDC announcements', 'banking sector news', 'IMF deal updates', 'how does current news affect cement?'. Runs three searches in parallel and merges them: (1) semantic vector similarity over article embeddings, (2) array-overlap on affected_sectors when a known sector is detected in the query (Banking, Cement, Chemical, Energy, Fertilizer, Food & Beverages, Insurance, Oil & Gas, Pharmaceuticals, Steel, Technology, Telecom, Textile, Real Estate, Automobile — common synonyms like 'bank', 'pharma', 'oil' also detected), (3) array-overlap on affected_tickers when uppercase tickers are present in the query. Results are deduped and ranked by signal strength (ticker hit > sector hit > vector match). Default 30-day window, max 90 days. Returns same enriched fields as getRecentHeadlines (summary, sentiment, affected_sectors, affected_tickers, impact_analysis) plus a `matchedOn` array showing which signals fired for each article. For broad 'what's happening' without a target, use getRecentHeadlines.",
      inputSchema: z.object({
        query:        z.string().describe("Natural language search query or company/ticker/sector name"),
        limit:        z.coerce.number().int().min(1).max(20).optional().default(10).describe("Results to return"),
        max_age_days: z.coerce.number().int().min(1).max(90).optional().default(30).describe("Only search articles from last N days"),
      }),
      execute: async ({ query, limit, max_age_days }) => {
        const effectiveLimit = limit ?? 10;
        const effectiveDays  = max_age_days ?? 30;

        const KNOWN_SECTORS = [
          "Banking", "Cement", "Chemical", "Energy", "Fertilizer",
          "Food & Beverages", "Insurance", "Oil & Gas", "Pharmaceuticals",
          "Steel", "Technology", "Telecom", "Textile", "Real Estate", "Automobile",
        ];
        const SECTOR_SYNONYMS: Record<string, string> = {
          "bank": "Banking", "banks": "Banking", "banking": "Banking", "financial": "Banking",
          "oil": "Oil & Gas", "gas": "Oil & Gas", "petroleum": "Oil & Gas", "e&p": "Oil & Gas",
          "tech": "Technology", " it ": "Technology", "software": "Technology",
          "telecoms": "Telecom", "telco": "Telecom", "telecom": "Telecom",
          "pharma": "Pharmaceuticals", "drug": "Pharmaceuticals", "medicine": "Pharmaceuticals",
          "fertiliser": "Fertilizer", "fertilizer": "Fertilizer", "urea": "Fertilizer", "dap": "Fertilizer",
          "food": "Food & Beverages", "beverage": "Food & Beverages", "fmcg": "Food & Beverages",
          "auto": "Automobile", "automotive": "Automobile", "car": "Automobile", "cars": "Automobile",
          "real estate": "Real Estate", "property": "Real Estate", "housing": "Real Estate",
          "cement": "Cement", "chemical": "Chemical", "steel": "Steel",
          "insurance": "Insurance", "energy": "Energy", "power": "Energy", "electricity": "Energy",
          "textile": "Textile", "garment": "Textile", "apparel": "Textile",
        };

        const lowerQuery = ` ${query.toLowerCase()} `;
        const detectedSectors = new Set<string>();
        for (const s of KNOWN_SECTORS) {
          if (lowerQuery.includes(s.toLowerCase())) detectedSectors.add(s);
        }
        for (const [key, val] of Object.entries(SECTOR_SYNONYMS)) {
          if (lowerQuery.includes(key)) detectedSectors.add(val);
        }
        const sectorList = Array.from(detectedSectors);

        // Tickers: uppercase 2-6 char tokens preserved verbatim from the query.
        const tickerList = Array.from(new Set(query.match(/\b[A-Z]{2,6}\b/g) ?? []));

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - effectiveDays);
        const cutoffISO = cutoff.toISOString();

        const SELECT_FIELDS =
          "id, title, url, source, published_at, ai_summary, sentiment, " +
          "affected_sectors, affected_tickers, impact_analysis";

        type Article = {
          id: string; title: string; url: string; source: string;
          published_at: string; ai_summary: string; sentiment: string;
          affected_sectors: string[]; affected_tickers: string[];
          impact_analysis: string;
        };
        type Scored = Article & { score: number; similarity?: number; matchedOn: string[] };

        const merged = new Map<string, Scored>();
        const addOrBoost = (
          a: Article,
          scoreAdd: number,
          tag: string,
          similarity?: number,
        ) => {
          const prev = merged.get(a.id);
          if (prev) {
            prev.score += scoreAdd;
            if (!prev.matchedOn.includes(tag)) prev.matchedOn.push(tag);
            if (similarity !== undefined && (prev.similarity ?? 0) < similarity) {
              prev.similarity = similarity;
            }
          } else {
            merged.set(a.id, { ...a, score: scoreAdd, similarity, matchedOn: [tag] });
          }
        };

        // Pull a wider candidate pool than the user asked for, so re-ranking has
        // material to work with.
        const broadLimit = Math.min(40, effectiveLimit * 4);

        const tasks: Promise<unknown>[] = [];

        // (1) Vector similarity — lower threshold than before so more borderline
        //     hits survive; we'll re-rank.
        tasks.push((async () => {
          try {
            const embedding = await generateEmbedding(ai, query, env);
            const { data, error } = await supabase.rpc("search_economic_news", {
              query_embedding: JSON.stringify(embedding),
              match_limit:     broadLimit,
              min_similarity:  0.30,
              max_age_days:    effectiveDays,
            });
            if (error) return;
            for (const r of (data ?? []) as Array<Article & { similarity: number }>) {
              addOrBoost(r, 1 + r.similarity, "vector", r.similarity);
            }
          } catch {
            // non-fatal
          }
        })());

        // (2) Sector overlap
        if (sectorList.length > 0) {
          tasks.push((async () => {
            try {
              const { data } = await supabase
                .from("economic_news")
                .select(SELECT_FIELDS)
                .overlaps("affected_sectors", sectorList)
                .gte("published_at", cutoffISO)
                .order("published_at", { ascending: false })
                .limit(broadLimit);
              for (const r of (data ?? []) as Article[]) {
                addOrBoost(r, 1.5, `sector:${sectorList.join("|")}`);
              }
            } catch {
              // non-fatal
            }
          })());
        }

        // (3) Ticker overlap
        if (tickerList.length > 0) {
          tasks.push((async () => {
            try {
              const { data } = await supabase
                .from("economic_news")
                .select(SELECT_FIELDS)
                .overlaps("affected_tickers", tickerList)
                .gte("published_at", cutoffISO)
                .order("published_at", { ascending: false })
                .limit(broadLimit);
              for (const r of (data ?? []) as Article[]) {
                addOrBoost(r, 2.0, `ticker:${tickerList.join("|")}`);
              }
            } catch {
              // non-fatal
            }
          })());
        }

        await Promise.all(tasks);

        const all = Array.from(merged.values());

        // Recency fallback when no signal fired
        if (all.length === 0) {
          try {
            const { data, error } = await supabase
              .from("economic_news")
              .select(SELECT_FIELDS)
              .gte("published_at", cutoffISO)
              .order("published_at", { ascending: false })
              .limit(effectiveLimit);
            if (error) throw new Error(error.message);
            return {
              query,
              detectedSectors: sectorList.length ? sectorList : undefined,
              detectedTickers: tickerList.length ? tickerList : undefined,
              articles: (data ?? []) as Article[],
              total: (data ?? []).length,
              note: "No targeted matches found — returning the most-recent articles in the window.",
            };
          } catch (err) {
            return {
              query,
              articles: [],
              total: 0,
              error: err instanceof Error ? err.message : "News search failed",
            };
          }
        }

        // Rank: higher score first, then more recent
        all.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
        });

        const articles = all.slice(0, effectiveLimit).map((s) => ({
          id: s.id,
          title: s.title,
          url: s.url,
          source: s.source,
          published_at: s.published_at,
          ai_summary: s.ai_summary,
          sentiment: s.sentiment,
          affected_sectors: s.affected_sectors,
          affected_tickers: s.affected_tickers,
          impact_analysis: s.impact_analysis,
          matchedOn: s.matchedOn,
          ...(s.similarity !== undefined
            ? { similarity: Math.round(s.similarity * 1000) / 1000 }
            : {}),
        }));

        return {
          query,
          detectedSectors: sectorList.length ? sectorList : undefined,
          detectedTickers: tickerList.length ? tickerList : undefined,
          articles,
          total: articles.length,
          totalCandidates: all.length,
        };
      },
    }),

    listFinancialDataInventory: tool({
      description:
        "Lists what company/period/table-type data ACTUALLY exists in the database. Use this BEFORE saying 'I don't have data' or guessing what's available — and ALWAYS use this when the user asks meta-questions like 'what companies do you know about', 'what data do you have', 'which periods are covered'. Returns distinct (company_name, fiscal_period, table_type) tuples from extracted_tables and (company, period) from finasaan_documents prose chunks. Optionally filter by a company substring. Cheap, non-vector, exact metadata lookup — never hallucinate company coverage; query this first.",
      inputSchema: z.object({
        company: z
          .string()
          .optional()
          .describe(
            "Optional substring filter — case-insensitive match on company_name and metadata.company. Leave blank to list everything.",
          ),
      }),
      execute: async ({ company }) => {
        try {
          const sanitize = (s: string) => s.replace(/[,()\\"]/g, "");
          const filter = company?.trim() ? sanitize(company.trim()) : null;

          // extracted_tables inventory
          let tQuery = supabase
            .from("extracted_tables")
            .select("company_id, company_name, fiscal_period, table_type")
            .limit(500);
          if (filter) {
            tQuery = tQuery.or(
              `company_name.ilike."%${filter}%",company_id.ilike."%${filter}%"`,
            );
          }
          const { data: tableRows, error: tErr } = await tQuery;
          if (tErr) throw new Error(`Table inventory failed: ${tErr.message}`);

          // finasaan_documents inventory (prose chunks)
          let dQuery = supabase
            .from("finasaan_documents")
            .select("metadata")
            .eq("domain", "financials")
            .limit(500);
          if (filter) {
            dQuery = dQuery.filter(
              "metadata->>company",
              "ilike",
              `%${filter}%`,
            );
          }
          const { data: docRows, error: dErr } = await dQuery;
          if (dErr) throw new Error(`Document inventory failed: ${dErr.message}`);

          // Aggregate distinct tuples
          const tableInventory = new Map<
            string,
            { company: string; period: string | null; tableType: string; count: number }
          >();
          for (const row of (tableRows || []) as Array<Record<string, unknown>>) {
            const c = (row.company_name as string) || (row.company_id as string) || "(unknown)";
            const p = (row.fiscal_period as string) || null;
            const tt = (row.table_type as string) || "general";
            const key = `${c}|${p ?? ""}|${tt}`;
            const prev = tableInventory.get(key);
            if (prev) prev.count++;
            else tableInventory.set(key, { company: c, period: p, tableType: tt, count: 1 });
          }

          const docInventory = new Map<
            string,
            { company: string | null; period: string | null; chunks: number }
          >();
          for (const row of (docRows || []) as Array<{ metadata: Record<string, unknown> | null }>) {
            const meta = row.metadata || {};
            const c = (meta.company as string) || null;
            const p = (meta.period as string) || null;
            const key = `${c ?? ""}|${p ?? ""}`;
            const prev = docInventory.get(key);
            if (prev) prev.chunks++;
            else docInventory.set(key, { company: c, period: p, chunks: 1 });
          }

          return {
            filter: company || null,
            extractedTables: Array.from(tableInventory.values()).sort((a, b) =>
              a.company.localeCompare(b.company),
            ),
            documentChunks: Array.from(docInventory.values())
              .filter((r) => r.company)
              .sort((a, b) => (a.company || "").localeCompare(b.company || "")),
            totals: {
              tableRows: (tableRows || []).length,
              docRows: (docRows || []).length,
              uniqueTableTuples: tableInventory.size,
              uniqueDocTuples: docInventory.size,
            },
          };
        } catch (err) {
          return {
            filter: company || null,
            extractedTables: [],
            documentChunks: [],
            error: err instanceof Error ? err.message : "Inventory query failed",
          };
        }
      },
    }),
  };
}

