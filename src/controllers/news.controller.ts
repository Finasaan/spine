import { Context } from "hono";
import { getSupabaseAdminClient } from "../db";
import { getRecentNews, getNewsById } from "../services/news.service";
import { runNewsCron } from "../services/news.cron.service";
import { successResponse, paginatedResponse, errorResponse } from "../types/index";


// GET /api/news
// Query params: limit, offset, sentiment, sector, ticker
export async function handleGetNews(
  c: Context<{ Bindings: CloudflareBindings }>
) {
  try {
    const { limit, offset, sentiment, sector, ticker } = c.req.query();
    const supabase = await getSupabaseAdminClient(c.env);

    const result = await getRecentNews(supabase, {
      limit:     limit     ? parseInt(limit, 10)  : 20,
      offset:    offset    ? parseInt(offset, 10) : 0,
      sentiment: sentiment as "positive" | "negative" | "neutral" | undefined,
      sector:    sector    || undefined,
      ticker:    ticker    || undefined,
    });

    return c.json(paginatedResponse(result.articles, {
      limit:  limit  ? parseInt(limit, 10)  : 20,
      offset: offset ? parseInt(offset, 10) : 0,
      total:  result.total,
    }));
  } catch (error) {
    console.error("[handleGetNews] error:", error);
    return c.json(errorResponse(error), 500);
  }
}

// GET /api/news/:id
export async function handleGetNewsItem(
  c: Context<{ Bindings: CloudflareBindings }>
) {
  try {
    const id = c.req.param("id");
    const supabase = await getSupabaseAdminClient(c.env);
    const article = await getNewsById(supabase, id);
    if (!article) return c.json({ success: false, error: "Not found" }, 404);
    return c.json(successResponse(article));
  } catch (error) {
    console.error("[handleGetNewsItem] error:", error);
    return c.json(errorResponse(error), 500);
  }
}

// GET /api/news/sync
export async function handleManualSync(
  c: Context<{ Bindings: CloudflareBindings }>
) {
  try {
    // This runs the same logic as the daily cron
    const report = await runNewsCron(c.env);
    return c.json(successResponse(report));
  } catch (error) {

    console.error("[handleManualSync] error:", error);
    return c.json(errorResponse(error), 500);
  }
}

