import type { TransactionFilter } from "./budget.types";

// ─── NL Query ────────────────────────────────────────────────────────────────

export interface FrontendQueryContext {
  last_category?: string | null;
  last_date_range?: string | null;
  last_metric?: string | null;
}

export interface NLQueryRequest {
  query: string;
  frontend_context?: FrontendQueryContext;
}

export interface ParsedQueryFilter extends TransactionFilter {
  metric: "total" | "average" | "count" | "list";
  date_range_label: string;   // human-readable: "last month", "March 2026", etc.
}

export interface TransactionListItem {
  id: string;
  date: string;
  description: string;
  amount: number;
  category_name: string;
  category_confidence?: number | null;
}

export interface QueryAggregation {
  metric: "total" | "average" | "count" | "list";
  value: number | null;             // null when metric = "list"
  currency: "PKR";
  category_name: string | null;
  date_range_label: string;
  transaction_count: number;
  transactions: TransactionListItem[];  // populated only when metric = "list"
  category_totals?: Array<{ category_name: string; amount: number }>;
}

export interface NLQueryResponse {
  original_query: string;
  parsed_filter: ParsedQueryFilter;
  aggregation: QueryAggregation;
  explanation: string;
  fallback: boolean;    // true if LLM parse failed; result uses default filter
}

// ─── Stored context (DB row shape) ───────────────────────────────────────────

export interface StoredQueryContext {
  user_id: string;
  last_category: string | null;
  last_date_range: string | null;
  last_metric: string | null;
  last_filters: TransactionFilter | null;
  updated_at: string;
}

// ─── Insights ─────────────────────────────────────────────────────────────────

export type InsightType = "increase" | "decrease" | "dominance" | "new_spending";

export interface RawInsightData {
  category_id: string;
  category_name: string;
  category_icon: string | null;
  category_color: string | null;
  current_amount: number;
  previous_amount: number | null;
  pct_change: number | null;
  share_of_total: number;     // 0–1 fraction of current month total expenses
}

export interface InsightEvent {
  type: InsightType;
  category_id: string;
  category_name: string;
  category_icon: string | null;
  category_color: string | null;
  current_amount: number;
  previous_amount: number | null;
  pct_change: number | null;
  share_of_total: number;
}

export interface SpendingInsight extends InsightEvent {
  explanation: string;
}

export interface InsightsResponse {
  month: number;
  year: number;
  insights: SpendingInsight[];
  generated_at: string;
}

// ─── Suggestions ──────────────────────────────────────────────────────────────

export type SuggestionReason =
  | "consistent_overspend"
  | "severe_overspend"
  | "opportunity_to_save";

export interface RawSuggestion {
  category_id: string;
  category_name: string;
  category_icon: string | null;
  category_color: string | null;
  current_budget: number;
  avg_spend_3m: number;
  overspend_months: number;   // count of months (out of last 3) where actual > budget * 1.10
  underspend_months: number;  // count of months (out of last 3) where actual < budget * 0.70
}

export interface BudgetSuggestionRaw {
  category_id: string;
  category_name: string;
  category_icon: string | null;
  category_color: string | null;
  current_budget: number;
  avg_spend_3m: number;
  suggested_budget: number;
  reason: SuggestionReason;
  overspend_months: number;
}

export interface BudgetSuggestion extends BudgetSuggestionRaw {
  explanation: string;
}

export interface SuggestionsResponse {
  month: number;
  year: number;
  suggestions: BudgetSuggestion[];
}
