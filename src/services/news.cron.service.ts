import { generateText } from "ai";
import { getSupabaseAdminClient } from "../db";
import { createModel, generateEmbeddings } from "./ai.service";
import type { ModelConfig } from "../types/chatbot.types";
import type { RSSItem, ArticleAnalysis, NewsInsertPayload } from "../types/news.types";
import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// Model config — same pattern as budget.ai.service.ts
// ============================================================

const NEWS_ANALYSIS_MODEL: ModelConfig = {
  id: "llama-3.1-8b-instant",
  name: "Llama 3.1 8B",
  provider: "groq",
  gatewayProvider: "groq",
  isPro: false,
  isEnabled: true,
  supportsToolCalling: false,
  contextWindow: 131072,
  maxOutputTokens: 512,
  description: "News article analysis",
};

// ============================================================
// RSS Feed Sources
// ============================================================

const RSS_FEEDS = [
  { url: "https://www.dawn.com/feeds/business", source: "Dawn Business" },
  { url: "https://profit.pakistantoday.com.pk/feed/", source: "Profit Pakistan Today" },
  { url: "https://tribune.com.pk/feed/business", source: "Tribune Business" },
];





// Max articles to process per feed per run
const MAX_PER_FEED = 10;

// ============================================================
// LLM Prompt
// ============================================================

const ANALYSIS_PROMPT = (title: string, description: string): string => `You are a financial analyst covering Pakistan's economy and PSX (Pakistan Stock Exchange).

Analyze this news article and return a JSON object. Be concise and precise.

Article title: ${title}
Article content: ${description}

Return ONLY valid JSON, no markdown fences, no extra text:
{
  "summary": "2-3 sentence summary of the key financial or economic development",
  "sentiment": "positive",
  "affected_sectors": ["Banking"],
  "affected_tickers": ["HBL"],
  "impact_analysis": "1-2 sentences on how this affects Pakistani stocks or investors"
}

Rules:
- sentiment must be exactly: "positive" (good for stocks/economy), "negative" (bad), or "neutral" (informational only)
- affected_sectors: only use values from this list — Banking, Cement, Chemical, Energy, Fertilizer, Food & Beverages, Insurance, Oil & Gas, Pharmaceuticals, Steel, Technology, Telecom, Textile, Real Estate, Automobile. Leave empty array if none clearly apply.
- affected_tickers: only include PSX tickers explicitly mentioned or very strongly implied (e.g. HBL, UBL, OGDC, PPL, LUCK, MCB, ENGRO, HUBC). Leave empty array if none.
- impact_analysis: leave as empty string "" if the article has no meaningful stock/investment angle.`;

// ============================================================
// Economic Filter
// ============================================================

const ECONOMIC_KEYWORDS = [
  "economy", "finance", "stock", "market", "psx", "fiscal", "tax", "trade", "industry", 
  "bank", "price", "inflation", "corporate", "profit", "revenue", "rate", "policy", 
  "budget", "interest", "currency", "investment", "exports", "imports", "deficit",
  "funding", "loan", "imf", "sector", "dividend", "acquisition", "merger", "regulation"
];

function isEconomicNews(item: RSSItem): boolean {
  const content = `${item.title} ${item.description}`.toLowerCase();
  return ECONOMIC_KEYWORDS.some(keyword => content.includes(keyword));
}


// ============================================================
// XML helpers
// ============================================================

function extractTagContent(block: string, tag: string): string {
  // Matches <tag>, <ns:tag>, or <tag attr="...">
  // The first capture group handles the namespace/attributes, the second is the content
  const fullMatch = block.match(
    new RegExp(`<(\\w+:)?${tag}(?:\\s+[^>]*?)?>([\\s\\S]*?)<\\/(\\w+:)?${tag}>`)
  );
  if (!fullMatch) return "";

  const content = fullMatch[2].trim();
  
  // Unwrap CDATA if present
  const cdataMatch = content.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return cdataMatch ? cdataMatch[1].trim() : content;
}


function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}

function parsePubDate(pubDate: string): string {
  if (!pubDate) return new Date().toISOString();
  const date = new Date(pubDate);
  return isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function parseRSSItems(xml: string): RSSItem[] {
  const items: RSSItem[] = [];
  
  // Support both RSS <item> and Atom <entry>, with optional namespaces
  const itemRegex = /<(\w+:)?(item|entry)(?:\s+[^>]*?)?>([\s\S]*?)<\/\1?\2>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[3];
    const title = extractTagContent(block, "title");
    
    // Link resolution
    let url = "";
    // Try plain <link> or <ns:link>
    const linkContent = extractTagContent(block, "link");
    if (linkContent && !linkContent.includes("<")) { // Ensure it's text, not a nested tag
      url = linkContent;
    } else {
      // Try Atom <link href="...">
      const atomLinkMatch = block.match(/<(\w+:)?link [^>]*href=["']([^"']+)["']/);
      url = atomLinkMatch ? atomLinkMatch[2].trim() : extractTagContent(block, "guid");
    }

    const description = extractTagContent(block, "description") || 
                        extractTagContent(block, "encoded") || // content:encoded
                        extractTagContent(block, "summary") || 
                        extractTagContent(block, "content");
    
    const pubDate = extractTagContent(block, "pubDate") || 
                    extractTagContent(block, "published") || 
                    extractTagContent(block, "updated");
    
    if (title && url) {
      items.push({ title, url, description, pubDate });
    }
  }
  return items;
}



// ============================================================
// Network helpers
// ============================================================

async function fetchAndParseRSS(feedUrl: string): Promise<RSSItem[]> {
  const response = await fetch(feedUrl, {
    headers: { 
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`RSS fetch failed: ${response.status}`);

  const xml = await response.text();
  return parseRSSItems(xml);
}

async function newsUrlExists(supabase: SupabaseClient, url: string): Promise<boolean> {
  const { data } = await supabase
    .from("economic_news")
    .select("id")
    .eq("url", url)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function insertNewsArticle(
  supabase: SupabaseClient,
  payload: NewsInsertPayload
): Promise<void> {
  const { error } = await supabase.from("economic_news").insert(payload);
  if (error) throw new Error(`Insert failed: ${error.message}`);
}

// ============================================================
// LLM analysis
// ============================================================

async function analyzeArticle(
  item: RSSItem,
  env: CloudflareBindings
): Promise<ArticleAnalysis> {
  const cleanDescription = stripHtml(item.description).slice(0, 800);
  const fallback: ArticleAnalysis = {
    summary: cleanDescription.slice(0, 300) || item.title,
    sentiment: "neutral",
    affected_sectors: [],
    affected_tickers: [],
    impact_analysis: "",
  };

  try {
    const model = createModel(
      env.AI_GATEWAY_TOKEN,
      env.AI_GATEWAY_BASE_URL,
      NEWS_ANALYSIS_MODEL
    );
    const result = await generateText({
      model,
      prompt: ANALYSIS_PROMPT(item.title, cleanDescription),
      temperature: 0,
      maxOutputTokens: NEWS_ANALYSIS_MODEL.maxOutputTokens,
    });


    // Strip any accidental markdown fences before parsing
    const cleaned = result.text
      .replace(/```json\n?/gi, "")
      .replace(/```\n?/gi, "")
      .trim();
    const parsed = JSON.parse(cleaned) as ArticleAnalysis;

    // Validate required fields
    const validSentiments = ["positive", "negative", "neutral"];
    return {
      summary:          typeof parsed.summary === "string" ? parsed.summary : fallback.summary,
      sentiment:        validSentiments.includes(parsed.sentiment) ? parsed.sentiment : "neutral",
      affected_sectors: Array.isArray(parsed.affected_sectors) ? parsed.affected_sectors : [],
      affected_tickers: Array.isArray(parsed.affected_tickers) ? parsed.affected_tickers : [],
      impact_analysis:  typeof parsed.impact_analysis === "string" ? parsed.impact_analysis : "",
    };
  } catch (err) {
    console.warn(`[NewsCron] LLM analysis failed for "${item.title}":`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

// ============================================================
// Main cron orchestrator — called by scheduled handler
// ============================================================

export interface NewsCronReport {
  feeds: Array<{
    source: string;
    fetched: number;
    processed: number;
    errors: string[];
  }>;
  totalNew: number;
}

export async function runNewsCron(env: CloudflareBindings): Promise<NewsCronReport> {
  const supabase = await getSupabaseAdminClient(env);
  let totalProcessed = 0;
  const report: NewsCronReport = { feeds: [], totalNew: 0 };

  for (const feed of RSS_FEEDS) {
    const feedReport = { source: feed.source, fetched: 0, processed: 0, errors: [] as string[] };
    report.feeds.push(feedReport);

    let items: RSSItem[] = [];
    try {
      items = await fetchAndParseRSS(feed.url);
      feedReport.fetched = items.length;
      console.log(`[NewsCron] Fetched ${items.length} items from ${feed.source}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      feedReport.errors.push(`Fetch failed: ${msg}`);
      console.error(`[NewsCron] Failed to fetch ${feed.source}:`, msg);
      continue;
    }

    for (const item of items.slice(0, MAX_PER_FEED)) {
      try {
        // Step 1: Dedup check
        if (await newsUrlExists(supabase, item.url)) {
          continue;
        }

        // Step 2: Economic relevance filter
        if (!isEconomicNews(item)) {
          console.log(`[NewsCron] Skipping non-economic article: "${item.title}"`);
          continue;
        }

        // Step 3: LLM analysis
        const analysis = await analyzeArticle(item, env);


        // Generate embedding: title + summary + impact (non-fatal — article still
        // stored on embedding failure; semantic search degrades to recency only)
        const embedText = [item.title, analysis.summary, analysis.impact_analysis]
          .filter(Boolean)
          .join(". ");
        let embedding: number[] | null = null;
        try {
          [embedding] = await generateEmbeddings(env.AI, [embedText], env);
        } catch (embedErr) {
          console.warn(
            `[NewsCron] Embedding failed for "${item.title}":`,
            embedErr instanceof Error ? embedErr.message : embedErr
          );
        }

        // Insert
        await insertNewsArticle(supabase, {
          url:              item.url,
          title:            item.title,
          source:           feed.source,
          published_at:     parsePubDate(item.pubDate),
          raw_summary:      stripHtml(item.description).slice(0, 1000),
          ai_summary:       analysis.summary,
          sentiment:        analysis.sentiment,
          affected_sectors: analysis.affected_sectors,
          affected_tickers: analysis.affected_tickers,
          impact_analysis:  analysis.impact_analysis,
          embedding:        embedding ? JSON.stringify(embedding) : null,
        });

        totalProcessed++;
        feedReport.processed++;
        console.log(`[NewsCron] Stored: "${item.title}"`);

        // Buffer to avoid rate limits (6s delay for 6k tokens/min limit)
        await new Promise(resolve => setTimeout(resolve, 6000));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        feedReport.errors.push(`Article error (${item.title}): ${msg}`);
        console.error(`[NewsCron] Failed to process article:`, msg);
      }
    }
  }

  report.totalNew = totalProcessed;
  console.log(`[NewsCron] Complete. Processed ${totalProcessed} new articles.`);
  return report;
}

