export interface BudgetCategory {
  id: string;
  user_id: string | null;
  name: string;
  slug: string;
  icon: string | null;
  color: string | null;
  is_system: boolean;
  is_active: boolean;
  aliases: string[] | null;
  sort_order: number;
}

export interface BudgetIncomeSource {
  id: string;
  user_id: string;
  source_name: string;
  amount: number;
  income_type: "salary" | "freelance" | "other";
  recurrence: "recurring" | "one-time";
  month: number;
  year: number;
  notes: string | null;
  created_at: string;
}

export interface BudgetTransaction {
  id: string;
  user_id: string;
  category_id: string;
  category?: BudgetCategory;
  amount: number;
  type: "income" | "expense";
  date: string;
  description: string;
  raw_description: string | null;
  category_confidence: number | null;
  notes: string | null;
  created_at: string;
}

export interface BudgetPlan {
  id: string;
  user_id: string;
  category_id: string | null;
  category?: BudgetCategory;
  planned_amount: number;
  month: number;
  year: number;
}

export interface SavingsGoal {
  id: string;
  user_id: string;
  goal_name: string;
  target_amount: number;
  current_amount: number;
  target_date: string | null;
  is_active: boolean;
  created_at: string;
}

export interface CreateIncomeBody {
  source_name: string;
  amount: number;
  income_type: "salary" | "freelance" | "other";
  recurrence: "recurring" | "one-time";
  month: number;
  year: number;
  notes?: string;
}

export interface CreateTransactionBody {
  category_id: string;
  amount: number;
  type: "income" | "expense";
  date: string;
  description: string;
  notes?: string;
}

export interface UpsertBudgetPlanBody {
  category_id: string | null;
  planned_amount: number;
  month: number;
  year: number;
}

export interface CreateSavingsGoalBody {
  goal_name: string;
  target_amount: number;
  current_amount?: number;
  target_date?: string;
}

export interface CreateCategoryBody {
  name: string;
  icon?: string;
  color?: string;
}

export interface TransactionFilter {
  user_id: string;
  month?: number;
  year?: number;
  date_from?: string;
  date_to?: string;
  category_id?: string;
  category_slug?: string;
  type?: "income" | "expense";
  description_contains?: string;
  amount_min?: number;
  amount_max?: number;
  limit?: number;
  offset?: number;
}

export interface CategoryBreakdown {
  category: BudgetCategory;
  actual: number;
  planned: number;
  percentage: number;
  over_budget: boolean;
}

export interface BudgetAlert {
  type:
    | "category_exceeded"
    | "category_80pct"
    | "monthly_cap_exceeded"
    | "monthly_cap_80pct"
    | "unusual_spike";
  message: string;
  category_slug?: string;
  severity: "warning" | "danger";
}

export interface BudgetDashboardData {
  month: number;
  year: number;
  total_income: number;
  total_expenses: number;
  savings: number;
  savings_rate: number;
  burn_rate: number;
  category_breakdown: CategoryBreakdown[];
  alerts: BudgetAlert[];
  daily_allowance: number | null;
  days_remaining: number;
}

export interface MonthlyHistoryPoint {
  month: number;
  year: number;
  total_income: number;
  total_expenses: number;
  savings: number;
  savings_rate: number;
}
