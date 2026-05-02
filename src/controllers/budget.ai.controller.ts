import { Context } from "hono";
import { getSupabaseAdminClient } from "../db";
import { successResponse, errorResponse } from "../types/index";
import { processNLQuery, getInsightsForMonth, getSuggestionsForMonth } from "../services/budget.ai.service";
import type { NLQueryRequest } from "../types/budget.ai.types";

// POST /budget/ai/query
// Body: NLQueryRequest
export async function handleNLQuery(c: Context<{ Bindings: CloudflareBindings }>) {
  try {
    const user = c.get("user");
    const body = await c.req.json<NLQueryRequest>();
    if (!body.query?.trim()) return c.json(errorResponse("query is required"), 400);

    const supabase = await getSupabaseAdminClient(c.env);
    const result = await processNLQuery(
      supabase,
      c.env.AI_GATEWAY_TOKEN,
      c.env.AI_GATEWAY_BASE_URL,
      user.id,
      body
    );

    return c.json(successResponse(result));
  } catch (err) {
    console.error("[handleNLQuery]", err);
    return c.json(errorResponse("Query failed"), 500);
  }
}

// GET /budget/ai/insights?month=&year=
export async function handleGetInsights(c: Context<{ Bindings: CloudflareBindings }>) {
  try {
    const user = c.get("user");
    const month = parseInt(c.req.query("month") ?? String(new Date().getMonth() + 1));
    const year  = parseInt(c.req.query("year")  ?? String(new Date().getFullYear()));

    if (isNaN(month) || month < 1 || month > 12) return c.json(errorResponse("Invalid month"), 400);
    if (isNaN(year)  || year < 2020)             return c.json(errorResponse("Invalid year"),  400);

    const supabase = await getSupabaseAdminClient(c.env);
    const result = await getInsightsForMonth(
      supabase,
      c.env.AI_GATEWAY_TOKEN,
      c.env.AI_GATEWAY_BASE_URL,
      user.id,
      month,
      year
    );

    return c.json(successResponse(result));
  } catch (err) {
    console.error("[handleGetInsights]", err);
    return c.json(errorResponse("Failed to generate insights"), 500);
  }
}

// GET /budget/ai/suggestions?month=&year=
export async function handleGetSuggestions(c: Context<{ Bindings: CloudflareBindings }>) {
  try {
    const user = c.get("user");
    const month = parseInt(c.req.query("month") ?? String(new Date().getMonth() + 1));
    const year  = parseInt(c.req.query("year")  ?? String(new Date().getFullYear()));

    if (isNaN(month) || month < 1 || month > 12) return c.json(errorResponse("Invalid month"), 400);
    if (isNaN(year)  || year < 2020)             return c.json(errorResponse("Invalid year"),  400);

    const supabase = await getSupabaseAdminClient(c.env);
    const result = await getSuggestionsForMonth(
      supabase,
      c.env.AI_GATEWAY_TOKEN,
      c.env.AI_GATEWAY_BASE_URL,
      user.id,
      month,
      year
    );

    return c.json(successResponse(result));
  } catch (err) {
    console.error("[handleGetSuggestions]", err);
    return c.json(errorResponse("Failed to generate suggestions"), 500);
  }
}
