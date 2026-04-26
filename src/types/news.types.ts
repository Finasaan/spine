// ============================================================
// news.types.ts — Types for economic news feature
// ============================================================

export interface RSSItem {
  title: string;
  url: string;
  description: string;
  pubDate: string;
}

export interface ArticleAnalysis {
  summary: string;
  sentiment: "positive" | "negative" | "neutral";
  affected_sectors: string[];
  affected_tickers: string[];
  impact_analysis: string;
}

export interface NewsInsertPayload {
  url: string;
  title: string;
  source: string;
  published_at: string;
  raw_summary: string;
  ai_summary: string;
  sentiment: "positive" | "negative" | "neutral";
  affected_sectors: string[];
  affected_tickers: string[];
  impact_analysis: string;
  embedding: string | null; // JSON.stringify of number[1024], or null if embedding generation failed
}

export interface EconomicNews {
  id: string;
  url: string;
  title: string;
  source: string;
  published_at: string;
  raw_summary: string | null;
  ai_summary: string | null;
  sentiment: "positive" | "negative" | "neutral";
  affected_sectors: string[];
  affected_tickers: string[];
  impact_analysis: string | null;
  created_at: string;
}

export interface NewsListParams {
  limit?: number;
  offset?: number;
  sentiment?: "positive" | "negative" | "neutral";
  sector?: string;
  ticker?: string;
}

export interface NewsListResult {
  articles: EconomicNews[];
  total: number;
}
