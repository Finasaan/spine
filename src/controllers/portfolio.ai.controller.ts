import { getSupabaseAdminClient } from "../db";
import { AppContext, successResponse, errorResponse } from "../types/index";
import { generatePortfolioAISummary } from "../services/portfolio.ai.service";

export async function handlePortfolioAISummary(c: AppContext) {
  try {
    const user = c.get("user");
    const supabase = await getSupabaseAdminClient(c.env);

    const result = await generatePortfolioAISummary(supabase, user.id, {
        AI_GATEWAY_TOKEN: c.env.AI_GATEWAY_TOKEN as string,
        AI_GATEWAY_BASE_URL: c.env.AI_GATEWAY_BASE_URL as string,
    });

    return c.json(successResponse(result));
  } catch (err) {
    console.error("[handlePortfolioAISummary] error:", err);
    return c.json(errorResponse(err), 500);
  }
}
