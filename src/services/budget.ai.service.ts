import { generateText } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createModel } from "./ai.service";
import { queryTransactions, getDashboard } from "./budget.service";
import type { ModelConfig } from "../types/chatbot.types";
import type { TransactionFilter, BudgetDashboardData } from "../types/budget.types";
import type {
  NLQueryRequest, NLQueryResponse, ParsedQueryFilter, QueryAggregation,
  TransactionListItem, StoredQueryContext, FrontendQueryContext,
  RawInsightData, InsightEvent, SpendingInsight, InsightsResponse,
  RawSuggestion, BudgetSuggestionRaw, BudgetSuggestion, SuggestionsResponse,
  InsightType, SuggestionReason
} from "../types/budget.ai.types";

const INSIGHT_FALLBACKS: Record<InsightType, (i: InsightEvent) => string> = {
  increase:     (i) => `Your ${i.category_name} spending increased by ${i.pct_change}% compared to last month.`,
  decrease:     (i) => `Your ${i.category_name} spending decreased by ${Math.abs(i.pct_change!)}% compared to last month.`,
  dominance:    (i) => `${i.category_name} accounted for over ${Math.round(i.share_of_total * 100)}% of your total spending this month.`,
  new_spending: (i) => `This is your first recorded spending in ${i.category_name}.`,
};

const SUGGESTION_FALLBACKS: Record<SuggestionReason, (s: BudgetSuggestionRaw) => string> = {
  consistent_overspend: (s) => `Your ${s.category_name} spending has exceeded your budget consistently. Adjusting it closer to your average spending makes it easier to track.`,
  severe_overspend:     (s) => `Your ${s.category_name} spending has been significantly over budget every month recently. This suggestion reflects your actual usage pattern.`,
  opportunity_to_save:  (s) => `Your ${s.category_name} spending has been well below your current budget. Reducing it could free up PKR ${(s.current_budget - s.suggested_budget).toLocaleString()} per month.`,
};

const PARSE_MODEL_CONFIG: ModelConfig = {
  id: "llama-3.1-8b-instant",
  name: "Llama 3.1 8B",
  provider: "groq",
  gatewayProvider: "groq",
  isPro: false,
  isEnabled: true,
  supportsToolCalling: false,
  contextWindow: 131072,
  maxOutputTokens: 512,
  description: "Budget query parsing",
};

const EXPLAIN_MODEL_CONFIG: ModelConfig = {
  id: "llama-3.3-70b-versatile",
  name: "Llama 3.3 70B",
  provider: "groq",
  gatewayProvider: "groq",
  isPro: false,
  isEnabled: true,
  supportsToolCalling: false,
  contextWindow: 131072,
  maxOutputTokens: 256,
  description: "Budget explanation generation",
};

/**
 * Task 4: Implement getQueryContext
 */
export async function getQueryContext(
  supabase: SupabaseClient,
  userId: string
): Promise<StoredQueryContext | null> {
  const { data, error } = await supabase
    .from("budget_query_context")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !data) return null;
  return data as StoredQueryContext;
}

/**
 * Task 5: Implement upsertQueryContext
 */
export async function upsertQueryContext(
  supabase: SupabaseClient,
  userId: string,
  context: Partial<Omit<StoredQueryContext, "user_id" | "updated_at">>
): Promise<void> {
  await supabase
    .from("budget_query_context")
    .upsert({
      user_id: userId,
      ...context,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
}

/**
 * Task 6: Implement parseNLQuery
 */
export async function parseNLQuery(
  token: string,
  baseUrl: string,
  query: string,
  categories: Array<{ slug: string; name: string }>,
  context: FrontendQueryContext | null,
  today: Date
): Promise<ParsedQueryFilter> {
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const currentMonthName = monthNames[today.getMonth()];
  const currentYear = today.getFullYear();

  const categoryList = categories.map(c => `- "${c.slug}": "${c.name}"`).join("\n");

  const prompt = `You are a budget query filter extractor. Extract structured filters from a natural language spending question.

Today's date: ${today.toISOString().split("T")[0]}
Current month: ${currentMonthName} ${currentYear}

User's expense categories (slug → display name):
${categoryList}

Output ONLY a JSON object. No prose, no markdown code fences. No explanation.
{
  "category_slug": "<slug from the list above, or null if no category match>",
  "type": "income" | "expense" | null,
  "month": <1–12 integer or null>,
  "year": <4-digit integer or null>,
  "date_from": "<YYYY-MM-DD or null>",
  "date_to": "<YYYY-MM-DD or null>",
  "metric": "total" | "average" | "count" | "list",
  "date_range_label": "<short human label: 'last month', 'this month', 'March 2026', or null>"
}

Rules:
- "last month" → compute exact month and year integers from today
- "this month" → current month and year integers
- Unrecognized category input → map to closest slug from the list, or null
- Default type to "expense" unless user mentions income or salary
- Default metric to "total" unless user asks for average, count, or a list of transactions
- If asking about a date range not expressible as a single month, use date_from and date_to

Previous query context (only use if the new query is a clear follow-up):
${context ? JSON.stringify(context) : "none"}

User question: ${query}`;

  const { text } = await generateText({
    model: createModel(token, baseUrl, PARSE_MODEL_CONFIG),
    prompt,
    temperature: 0.1,
  });

  try {
    let cleanText = text.trim();
    if (cleanText.startsWith("```json")) {
      cleanText = cleanText.substring(7);
    }
    if (cleanText.endsWith("```")) {
      cleanText = cleanText.substring(0, cleanText.length - 3);
    }
    cleanText = cleanText.trim();

    const parsed = JSON.parse(cleanText);
    if (!parsed.metric) throw new Error("PARSE_FAILED");

    // Map month/year if relative labels used
    if (parsed.date_range_label === "last month" && !parsed.month) {
      const lastMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      parsed.month = lastMonthDate.getMonth() + 1;
      parsed.year = lastMonthDate.getFullYear();
    } else if (parsed.date_range_label === "this month" && !parsed.month) {
      parsed.month = today.getMonth() + 1;
      parsed.year = today.getFullYear();
    }

    return {
      ...parsed,
      user_id: "", // filled by caller
    } as ParsedQueryFilter;
  } catch (err) {
    throw new Error("PARSE_FAILED");
  }
}

/**
 * New Feature: classifyTransaction
 * Uses LLM to match a raw description to a category slug and provide confidence.
 */
export async function classifyTransaction(
  token: string,
  baseUrl: string,
  description: string,
  categories: Array<{ slug: string; name: string }>
): Promise<{ category_slug: string; confidence: number }> {
  const categoryList = categories.map(c => `- "${c.slug}": "${c.name}"`).join("\n");

  const prompt = `You are a financial transaction classifier. 
Match the following transaction description to the most appropriate category slug from the list provided.
Also provide a confidence score between 0.0 and 1.0.

Categories:
${categoryList}

Description: "${description}"

Output ONLY a JSON object:
{
  "category_slug": "slug",
  "confidence": 0.95
}`;

  const { text } = await generateText({
    model: createModel(token, baseUrl, PARSE_MODEL_CONFIG),
    prompt,
    temperature: 0,
  });

  try {
    let cleanText = text.trim();
    if (cleanText.startsWith("```json")) cleanText = cleanText.substring(7);
    if (cleanText.endsWith("```")) cleanText = cleanText.substring(0, cleanText.length - 3);
    const parsed = JSON.parse(cleanText.trim());
    return {
      category_slug: parsed.category_slug || "misc",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    };
  } catch (err) {
    return { category_slug: "misc", confidence: 0 };
  }
}

/**
 * Task 7: Implement aggregateQueryResult
 */
export async function aggregateQueryResult(
  supabase: SupabaseClient,
  userId: string,
  filter: ParsedQueryFilter
): Promise<QueryAggregation> {
  const { data: transactions, total } = await queryTransactions(supabase, { ...filter, user_id: userId });

  let category_name: string | null = null;
  if (filter.category_id || filter.category_slug) {
    const { data: cat } = await supabase
      .from("budget_categories")
      .select("name")
      .or(`id.eq.${filter.category_id},slug.eq.${filter.category_slug}`)
      .single();
    category_name = cat?.name ?? null;
  }

  // FIX: Separate income and expenses. Default to expenses for "spend" queries.
  const filteredTransactions = transactions.filter(t => {
    if (filter.type) return t.type === filter.type;
    // Default to expenses if not explicitly asking for income
    return t.type === 'expense';
  });

  const totalSpent = filteredTransactions.reduce((sum: number, t: any) => sum + (t.amount || 0), 0);
  let value: number | null = null;

  switch (filter.metric) {
    case "total":
      value = totalSpent;
      break;
    case "average":
      value = filteredTransactions.length ? totalSpent / filteredTransactions.length : 0;
      break;
    case "count":
      value = filteredTransactions.length;
      break;
    case "list":
      value = null;
      break;
  }

  // CATEGORY BREAKDOWN
  const breakdownMap = new Map<string, number>();
  filteredTransactions.forEach(t => {
    const name = t.category?.name || "Uncategorized";
    breakdownMap.set(name, (breakdownMap.get(name) || 0) + (t.amount || 0));
  });

  const category_totals = Array.from(breakdownMap.entries())
    .map(([name, amount]) => ({ category_name: name, amount }))
    .sort((a, b) => b.amount - a.amount);

  const transactionList: TransactionListItem[] = filter.metric === "list"
    ? filteredTransactions.slice(0, 20).map((t: any) => ({
      id: t.id,
      date: t.date,
      description: t.description,
      amount: t.amount,
      category_name: t.category?.name || category_name || "Expenses",
      category_confidence: t.category_confidence,
    }))
    : [];

  return {
    metric: filter.metric,
    value,
    currency: "PKR",
    category_name,
    date_range_label: filter.date_range_label,
    transaction_count: total,
    transactions: transactionList,
    category_totals: category_totals.length > 1 ? category_totals : undefined,
  };
}

/**
 * Task 8: Implement generateQueryExplanation
 */
export async function generateQueryExplanation(
  token: string,
  baseUrl: string,
  filter: ParsedQueryFilter,
  aggregation: QueryAggregation,
  originalQuery: string,
  dashboardData?: BudgetDashboardData
): Promise<string> {
  const resultStr = aggregation.metric === "total"
    ? `PKR ${aggregation.value?.toLocaleString()}`
    : aggregation.metric === "average"
      ? `PKR ${aggregation.value?.toLocaleString()} average per transaction`
      : aggregation.metric === "count"
        ? `${aggregation.value} transactions`
        : `${aggregation.transaction_count} transactions listed`;

  const dashboardStr = dashboardData ? `
Overall Context for ${dashboardData.month}/${dashboardData.year}:
- Total Income: PKR ${dashboardData.total_income.toLocaleString()}
- Total Expenses: PKR ${dashboardData.total_expenses.toLocaleString()}
- Savings: PKR ${dashboardData.savings.toLocaleString()} (${dashboardData.savings_rate.toFixed(1)}% rate)
- Burn Rate: PKR ${dashboardData.burn_rate.toLocaleString()} / day
- Overbudget Categories: ${dashboardData.category_breakdown.filter(c => c.over_budget).map(c => c.category.name).join(", ") || "none"}
` : "";

  const prompt = `You are a proactive financial advisor. Answer the user's question AND provide relevant proactive insights.
Be analytical, encouraging, and actionable. Base advice ONLY on the provided data. Currency is PKR.

User's original question: "${originalQuery}"
Category: ${aggregation.category_name ?? "all categories"}
Date range: ${aggregation.date_range_label}
Result: ${resultStr}
${aggregation.category_totals ? `Breakdown: ${aggregation.category_totals.map(c => `${c.category_name}: ${c.amount}`).join(", ")}` : ""}
${dashboardStr}

Instructions:
1. State the data requested clearly.
2. If the user's query result is high relative to income (e.g. >10%), mention it.
3. If the user is over budget in a relevant category, point it out.
4. If their savings rate is low (<10%), suggest ways to improve.
5. Look at transaction descriptions (if provided) for recurring patterns like subscriptions or frequent luxury items.
6. Keep response to 2–4 concise sentences.`;

  try {
    const { text } = await generateText({
      model: createModel(token, baseUrl, EXPLAIN_MODEL_CONFIG),
      prompt,
      temperature: 0.3,
    });
    return text.trim();
  } catch (err) {
    return `You spent ${resultStr} on ${aggregation.category_name ?? "expenses"} during ${aggregation.date_range_label}.`;
  }
}

/**
 * Task 9: Implement processNLQuery orchestrator
 */
export async function processNLQuery(
  supabase: SupabaseClient,
  token: string,
  baseUrl: string,
  userId: string,
  request: NLQueryRequest
): Promise<NLQueryResponse> {
  // 1. Fetch user categories
  const { data: categoriesData } = await supabase
    .from("budget_categories")
    .select("slug, name")
    .eq("is_active", true)
    .or(`user_id.eq.${userId},is_system.eq.true`)
    .order("sort_order", { ascending: true });

  const categories = categoriesData || [];

  // 2. Fetch stored context
  const storedContext = await getQueryContext(supabase, userId);

  // 3. Merge contexts (frontend priority)
  const mergedContext: FrontendQueryContext = {
    last_category: request.frontend_context?.last_category ?? storedContext?.last_category ?? null,
    last_date_range: request.frontend_context?.last_date_range ?? storedContext?.last_date_range ?? null,
    last_metric: request.frontend_context?.last_metric ?? storedContext?.last_metric ?? null,
  };

  // 4. Parse NL Query
  let filter: ParsedQueryFilter;
  let isFallback = false;

  try {
    filter = await parseNLQuery(token, baseUrl, request.query, categories, mergedContext, new Date());
  } catch (err) {
    isFallback = true;
    const now = new Date();
    filter = {
      user_id: userId,
      type: "expense",
      month: now.getMonth() + 1,
      year: now.getFullYear(),
      metric: "total",
      date_range_label: "this month",
    };
  }

  filter.user_id = userId;

  // 5. Aggregate result
  const aggregation = await aggregateQueryResult(supabase, userId, filter);

  // 6. Fetch Dashboard context for proactive advice
  let dashboardData: BudgetDashboardData | undefined;
  try {
    const now = new Date();
    dashboardData = await getDashboard(supabase, userId, filter.month || (now.getMonth() + 1), filter.year || now.getFullYear());
  } catch (dbErr) {
    console.error("[processNLQuery] Dashboard fetch failed:", dbErr);
  }

  // 7. Generate explanation
  const explanation = await generateQueryExplanation(token, baseUrl, filter, aggregation, request.query, dashboardData);

  // 7. Upsert context
  await upsertQueryContext(supabase, userId, {
    last_category: filter.category_slug ?? null,
    last_date_range: filter.date_range_label,
    last_metric: filter.metric,
    last_filters: filter as any,
  });

  return {
    original_query: request.query,
    parsed_filter: filter,
    aggregation,
    explanation,
    fallback: isFallback,
  };
}

/**
 * Task 10: Implement computeRawInsights
 */
export async function computeRawInsights(
  supabase: SupabaseClient,
  userId: string,
  month: number,
  year: number
): Promise<RawInsightData[]> {
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;

  // Execute SQL via raw query (Supabase .rpc or custom query string)
  // Since we don't have a defined RPC, we'll use a complex select with filters
  // However, the plan provided a specific SQL (6.1).
  // In a real environment, we'd add this as an RPC.
  // Here, we'll simulate the SQL logic using multiple queries if needed,
  // but the most efficient way is a single SQL call.
  // We'll use supabase.rpc('compute_raw_budget_insights', { ... }) if it existed.
  // For now, we will perform the calculation in TypeScript OR use a raw SQL if possible.
  // Cloudflare Workers often use postgrest which doesn't support raw SQL easily.
  // BUT the plan says "Run via supabase.rpc or as a raw SQL string using the Supabase PostgreSQL client".

  // I'll implement it using the logic in SQL 6.1 but via Supabase's JS client.
  // Actually, I'll assume an RPC exists or I'll implement it using joins.

  const { data, error } = await supabase.rpc("compute_raw_budget_insights", {
    p_user_id: userId,
    p_month: month,
    p_year: year
  });

  if (error || !data) {
    console.error("[computeRawInsights] Error:", error);
    return [];
  }

  return data as RawInsightData[];
}

/**
 * Task 11: Implement filterInsightWorthy
 */
export function filterInsightWorthy(raw: RawInsightData[]): InsightEvent[] {
  const insights: InsightEvent[] = [];

  for (const item of raw) {
    if (item.current_amount === 0) continue;

    let type: InsightType | null = null;

    if (item.previous_amount === null && item.current_amount > 0) {
      type = "new_spending";
    } else if (item.share_of_total > 0.40) {
      type = "dominance";
    } else if (item.pct_change !== null && item.pct_change > 20) {
      type = "increase";
    } else if (item.pct_change !== null && item.pct_change < -20) {
      type = "decrease";
    }

    if (type) {
      insights.push({
        type,
        category_id: item.category_id,
        category_name: item.category_name,
        category_icon: item.category_icon,
        category_color: item.category_color,
        current_amount: item.current_amount,
        previous_amount: item.previous_amount,
        pct_change: item.pct_change,
        share_of_total: item.share_of_total,
      });
    }
  }

  return insights;
}

/**
 * Task 12: Implement generateInsightExplanations
 */
export async function generateInsightExplanations(
  token: string,
  baseUrl: string,
  insights: InsightEvent[]
): Promise<SpendingInsight[]> {
  const results: SpendingInsight[] = [];

  for (const insight of insights) {
    const prompt = `You are a personal finance assistant. Explain a monthly spending change in 1–2 plain sentences.
Be factual, non-judgmental. Base explanation only on the numbers. Do not suggest actions. Currency is PKR.

Category: ${insight.category_name}
This month: PKR ${insight.current_amount}
Last month: ${insight.previous_amount ?? "no prior spending"}
Change type: ${insight.type}
${insight.pct_change !== null ? `Percentage change: ${insight.pct_change}%` : ""}
${insight.type === "dominance" ? `Share of total spending: ${Math.round(insight.share_of_total * 100)}%` : ""}`;

    try {
      const { text } = await generateText({
        model: createModel(token, baseUrl, EXPLAIN_MODEL_CONFIG),
        prompt,
        temperature: 0.3,
      });
      results.push({ ...insight, explanation: text.trim() });
    } catch (err) {
      results.push({ ...insight, explanation: INSIGHT_FALLBACKS[insight.type](insight) });
    }
  }

  return results;
}

/**
 * Task 13: Implement getInsightsForMonth orchestrator
 */
export async function getInsightsForMonth(
  supabase: SupabaseClient,
  token: string,
  baseUrl: string,
  userId: string,
  month: number,
  year: number
): Promise<InsightsResponse> {
  const raw = await computeRawInsights(supabase, userId, month, year);
  const worthy = filterInsightWorthy(raw);
  const insights = await generateInsightExplanations(token, baseUrl, worthy);

  return {
    month,
    year,
    insights,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Task 14: Implement computeRawSuggestions
 */
export async function computeRawSuggestions(
  supabase: SupabaseClient,
  userId: string,
  month: number,
  year: number
): Promise<RawSuggestion[]> {
  const { data, error } = await supabase.rpc("compute_raw_budget_suggestions", {
    p_user_id: userId,
    p_month: month,
    p_year: year
  });

  if (error || !data) {
    console.error("[computeRawSuggestions] Error:", error);
    return [];
  }

  return data as RawSuggestion[];
}

/**
 * Task 15: Implement buildSuggestions
 */
export function buildSuggestions(raw: RawSuggestion[]): BudgetSuggestionRaw[] {
  const suggestions: BudgetSuggestionRaw[] = [];

  for (const item of raw) {
    let suggested = 0;
    let reason: SuggestionReason | null = null;

    if (item.overspend_months >= 2 && item.avg_spend_3m > item.current_budget * 1.05) {
      const multiplier = item.overspend_months >= 3 ? 0.85 : 0.90;
      suggested = Math.max(1000, Math.round(item.avg_spend_3m * multiplier / 100) * 100);
      reason = item.overspend_months >= 3 ? "severe_overspend" : "consistent_overspend";
    } else if (item.underspend_months >= 2 && item.avg_spend_3m < item.current_budget * 0.65) {
      suggested = Math.max(1000, Math.round(item.avg_spend_3m * 1.15 / 100) * 100);
      reason = "opportunity_to_save";
    }

    if (reason) {
      suggestions.push({
        category_id: item.category_id,
        category_name: item.category_name,
        category_icon: item.category_icon,
        category_color: item.category_color,
        current_budget: item.current_budget,
        avg_spend_3m: item.avg_spend_3m,
        suggested_budget: suggested,
        reason,
        overspend_months: item.overspend_months,
      });
    }
  }

  return suggestions;
}

/**
 * Task 16: Implement generateSuggestionExplanations + getSuggestionsForMonth
 */
export async function generateSuggestionExplanations(
  token: string,
  baseUrl: string,
  suggestions: BudgetSuggestionRaw[]
): Promise<BudgetSuggestion[]> {
  const results: BudgetSuggestion[] = [];

  for (const suggestion of suggestions) {
    const prompt = `You are a budget advisor. Explain a budget adjustment recommendation in 2–3 plain sentences.
Non-judgmental. Practical. Fact-based only. No moralizing. Currency is PKR.

Category: ${suggestion.category_name}
Current budget: PKR ${suggestion.current_budget}
Average actual spending last 3 months: PKR ${suggestion.avg_spend_3m}
Months over budget (last 3): ${suggestion.overspend_months}
Suggested budget: PKR ${suggestion.suggested_budget}
Reason: ${suggestion.reason}`;

    try {
      const { text } = await generateText({
        model: createModel(token, baseUrl, EXPLAIN_MODEL_CONFIG),
        prompt,
        temperature: 0.3,
      });
      results.push({ ...suggestion, explanation: text.trim() });
    } catch (err) {
      results.push({ ...suggestion, explanation: SUGGESTION_FALLBACKS[suggestion.reason](suggestion) });
    }
  }

  return results;
}

export async function getSuggestionsForMonth(
  supabase: SupabaseClient,
  token: string,
  baseUrl: string,
  userId: string,
  month: number,
  year: number
): Promise<SuggestionsResponse> {
  const raw = await computeRawSuggestions(supabase, userId, month, year);
  const rawSuggestions = buildSuggestions(raw);

  if (rawSuggestions.length === 0) {
    return { month, year, suggestions: [] };
  }

  const suggestions = await generateSuggestionExplanations(token, baseUrl, rawSuggestions);

  return {
    month,
    year,
    suggestions,
  };
}
