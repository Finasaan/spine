import type { SupabaseClient } from "@supabase/supabase-js";
import type { EconomicNews, NewsListParams, NewsListResult } from "../types/news.types";

export async function getRecentNews(
  supabase: SupabaseClient,
  params: NewsListParams
): Promise<NewsListResult> {
  const limit  = Math.min(params.limit  ?? 20, 50);
  const offset = params.offset ?? 0;

  let query = supabase
    .from("economic_news")
    .select("id, url, title, source, published_at, ai_summary, sentiment, affected_sectors, affected_tickers, impact_analysis, created_at", { count: "exact" })
    .order("published_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (params.sentiment) {
    query = query.eq("sentiment", params.sentiment);
  }
  if (params.sector) {
    query = query.contains("affected_sectors", [params.sector]);
  }
  if (params.ticker) {
    query = query.contains("affected_tickers", [params.ticker.toUpperCase()]);
  }

  const { data, error, count } = await query;
  if (error) throw new Error(`Failed to query news: ${error.message}`);

  return {
    articles: (data ?? []) as EconomicNews[],
    total:    count ?? 0,
  };
}

export async function getNewsById(
  supabase: SupabaseClient,
  id: string
): Promise<EconomicNews | null> {
  const { data, error } = await supabase
    .from("economic_news")
    .select("id, url, title, source, published_at, raw_summary, ai_summary, sentiment, affected_sectors, affected_tickers, impact_analysis, created_at")
    .eq("id", id)
    .single();

  if (error) return null;
  return data as EconomicNews;
}
