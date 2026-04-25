import { SupabaseClient } from "@supabase/supabase-js";
import {
  BudgetCategory,
  BudgetIncomeSource,
  BudgetTransaction,
  BudgetPlan,
  SavingsGoal,
  CreateIncomeBody,
  CreateTransactionBody,
  UpsertBudgetPlanBody,
  CreateSavingsGoalBody,
  CreateCategoryBody,
  TransactionFilter,
  BudgetDashboardData,
  CategoryBreakdown,
  BudgetAlert,
  MonthlyHistoryPoint,
} from "../types/budget.types";

interface BudgetTransactionRow {
  id: string;
  user_id: string;
  category_id: string;
  amount: number;
  type: "income" | "expense";
  date: string;
  description: string;
  raw_description: string | null;
  category_confidence: number | null;
  notes: string | null;
  created_at: string;
  category: BudgetCategory | BudgetCategory[] | null;
}

interface BudgetPlanRow {
  id: string;
  user_id: string;
  category_id: string | null;
  planned_amount: number;
  month: number;
  year: number;
  category: BudgetCategory | BudgetCategory[] | null;
}

function throwIfError(error: unknown): void {
  if (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Database operation failed");
  }
}

function toISODateString(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function monthBoundaries(month: number, year: number): {
  startDate: string;
  endDateExclusive: string;
} {
  const startDate = toISODateString(year, month, 1);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endDateExclusive = toISODateString(nextYear, nextMonth, 1);
  return { startDate, endDateExclusive };
}

function getDaysInMonth(month: number, year: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isCurrentMonth(month: number, year: number): boolean {
  const now = new Date();
  return now.getUTCFullYear() === year && now.getUTCMonth() + 1 === month;
}

function getDaysRemainingInMonth(month: number, year: number): number {
  const today = new Date();
  const todayDate = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );

  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 0));

  if (monthEnd < todayDate) {
    return 0;
  }

  if (monthStart > todayDate) {
    return getDaysInMonth(month, year);
  }

  return Math.max(0, monthEnd.getUTCDate() - todayDate.getUTCDate() + 1);
}

function daysBetweenInclusive(startDate: Date, endDate: Date): number {
  const start = Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate()
  );
  const end = Date.UTC(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth(),
    endDate.getUTCDate()
  );
  const diffMs = end - start;

  if (diffMs < 0) {
    return 0;
  }

  return Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
}

function makeSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatPKR(amount: number): string {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(amount);
}

function normalizeTransactionRow(row: BudgetTransactionRow): BudgetTransaction {
  const categoryValue = Array.isArray(row.category)
    ? row.category[0]
    : row.category;

  return {
    id: row.id,
    user_id: row.user_id,
    category_id: row.category_id,
    amount: Number(row.amount),
    type: row.type,
    date: row.date,
    description: row.description,
    raw_description: row.raw_description,
    category_confidence:
      row.category_confidence === null
        ? null
        : Number(row.category_confidence),
    notes: row.notes,
    created_at: row.created_at,
    category: categoryValue ?? undefined,
  };
}

function normalizePlanRow(row: BudgetPlanRow): BudgetPlan {
  const categoryValue = Array.isArray(row.category)
    ? row.category[0]
    : row.category;

  return {
    id: row.id,
    user_id: row.user_id,
    category_id: row.category_id,
    planned_amount: Number(row.planned_amount),
    month: row.month,
    year: row.year,
    category: categoryValue ?? undefined,
  };
}

async function assertCategoryAccessible(
  db: SupabaseClient,
  userId: string,
  categoryId: string
): Promise<void> {
  const { data, error } = await db
    .from("budget_categories")
    .select("id")
    .eq("id", categoryId)
    .eq("is_active", true)
    .or(`is_system.eq.true,user_id.eq.${userId}`)
    .limit(1)
    .single();

  if (error || !data) {
    throw new Error("Category not found or inaccessible");
  }
}

async function resolveCategoryIdsBySlug(
  db: SupabaseClient,
  userId: string,
  categorySlug: string
): Promise<string[]> {
  const { data, error } = await db
    .from("budget_categories")
    .select("id")
    .eq("slug", categorySlug)
    .eq("is_active", true)
    .or(`is_system.eq.true,user_id.eq.${userId}`);

  throwIfError(error);

  const rows = (data ?? []) as Array<{ id: string }>;
  return rows.map((item) => item.id);
}

function buildCategoryPlanMap(plans: BudgetPlan[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const plan of plans) {
    if (plan.category_id) {
      map.set(plan.category_id, Number(plan.planned_amount));
    }
  }
  return map;
}

function getCurrentDayForBurnRate(month: number, year: number): number {
  if (!isCurrentMonth(month, year)) {
    return getDaysInMonth(month, year);
  }

  const day = new Date().getUTCDate();
  return Math.max(1, Math.min(day, getDaysInMonth(month, year)));
}

// ---- CATEGORIES ----

export async function getCategories(
  db: SupabaseClient,
  userId: string
): Promise<BudgetCategory[]> {
  const { data, error } = await db
    .from("budget_categories")
    .select(
      "id, user_id, name, slug, icon, color, is_system, is_active, aliases, sort_order"
    )
    .eq("is_active", true)
    .or(`is_system.eq.true,user_id.eq.${userId}`)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  throwIfError(error);

  return (data ?? []) as BudgetCategory[];
}

export async function createCategory(
  db: SupabaseClient,
  userId: string,
  body: CreateCategoryBody
): Promise<BudgetCategory> {
  const name = body.name.trim();
  if (!name) {
    throw new Error("Category name is required");
  }

  const slug = makeSlug(name);
  if (!slug) {
    throw new Error("Category name must include letters or numbers");
  }

  const { data: existing, error: existingError } = await db
    .from("budget_categories")
    .select("id")
    .eq("user_id", userId)
    .eq("slug", slug)
    .limit(1);

  throwIfError(existingError);

  if ((existing ?? []).length > 0) {
    throw new Error("A category with this slug already exists");
  }

  const { data, error } = await db
    .from("budget_categories")
    .insert({
      user_id: userId,
      name,
      slug,
      icon: body.icon ?? null,
      color: body.color ?? null,
      is_system: false,
      is_active: true,
      aliases: null,
      sort_order: 99,
    })
    .select(
      "id, user_id, name, slug, icon, color, is_system, is_active, aliases, sort_order"
    )
    .single();

  throwIfError(error);

  if (!data) {
    throw new Error("Failed to create category");
  }

  return data as BudgetCategory;
}

export async function updateCategory(
  db: SupabaseClient,
  userId: string,
  categoryId: string,
  body: Partial<CreateCategoryBody>
): Promise<BudgetCategory> {
  const updates: {
    name?: string;
    slug?: string;
    icon?: string | null;
    color?: string | null;
  } = {};

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) {
      throw new Error("Category name cannot be empty");
    }
    updates.name = name;
    updates.slug = makeSlug(name);
  }

  if (body.icon !== undefined) {
    updates.icon = body.icon?.trim() || null;
  }

  if (body.color !== undefined) {
    updates.color = body.color?.trim() || null;
  }

  if (Object.keys(updates).length === 0) {
    throw new Error("No category fields provided for update");
  }

  if (updates.slug) {
    const { data: existing, error: existingError } = await db
      .from("budget_categories")
      .select("id")
      .eq("user_id", userId)
      .eq("slug", updates.slug)
      .neq("id", categoryId)
      .limit(1);

    throwIfError(existingError);

    if ((existing ?? []).length > 0) {
      throw new Error("A category with this slug already exists");
    }
  }

  const { data, error } = await db
    .from("budget_categories")
    .update(updates)
    .eq("id", categoryId)
    .eq("user_id", userId)
    .eq("is_system", false)
    .select(
      "id, user_id, name, slug, icon, color, is_system, is_active, aliases, sort_order"
    )
    .single();

  throwIfError(error);

  if (!data) {
    throw new Error("Category not found");
  }

  return data as BudgetCategory;
}

export async function deleteCategory(
  db: SupabaseClient,
  userId: string,
  categoryId: string
): Promise<void> {
  const { count, error: txError } = await db
    .from("budget_transactions")
    .select("id", { head: true, count: "exact" })
    .eq("user_id", userId)
    .eq("category_id", categoryId);

  throwIfError(txError);

  if ((count ?? 0) > 0) {
    throw new Error(
      "Cannot delete a category that has transactions. Reassign transactions first."
    );
  }

  const { data, error } = await db
    .from("budget_categories")
    .update({ is_active: false })
    .eq("id", categoryId)
    .eq("user_id", userId)
    .eq("is_system", false)
    .select("id")
    .single();

  throwIfError(error);

  if (!data) {
    throw new Error("Category not found");
  }
}

// ---- INCOME ----

export async function getIncome(
  db: SupabaseClient,
  userId: string,
  month: number,
  year: number
): Promise<BudgetIncomeSource[]> {
  const { data, error } = await db
    .from("budget_income_sources")
    .select(
      "id, user_id, source_name, amount, income_type, recurrence, month, year, notes, created_at"
    )
    .eq("user_id", userId)
    .eq("month", month)
    .eq("year", year)
    .order("created_at", { ascending: false });

  throwIfError(error);

  return ((data ?? []) as BudgetIncomeSource[]).map((row) => ({
    ...row,
    amount: Number(row.amount),
  }));
}

export async function createIncome(
  db: SupabaseClient,
  userId: string,
  body: CreateIncomeBody
): Promise<BudgetIncomeSource> {
  const { data, error } = await db
    .from("budget_income_sources")
    .insert({
      user_id: userId,
      source_name: body.source_name.trim(),
      amount: body.amount,
      income_type: body.income_type,
      recurrence: body.recurrence,
      month: body.month,
      year: body.year,
      notes: body.notes ?? null,
    })
    .select(
      "id, user_id, source_name, amount, income_type, recurrence, month, year, notes, created_at"
    )
    .single();

  throwIfError(error);

  if (!data) {
    throw new Error("Failed to create income source");
  }

  const row = data as BudgetIncomeSource;
  return { ...row, amount: Number(row.amount) };
}

export async function updateIncome(
  db: SupabaseClient,
  userId: string,
  incomeId: string,
  body: Partial<CreateIncomeBody>
): Promise<BudgetIncomeSource> {
  const updates: {
    source_name?: string;
    amount?: number;
    income_type?: "salary" | "freelance" | "other";
    recurrence?: "recurring" | "one-time";
    month?: number;
    year?: number;
    notes?: string | null;
    updated_at: string;
  } = {
    updated_at: new Date().toISOString(),
  };

  if (body.source_name !== undefined) {
    updates.source_name = body.source_name.trim();
  }
  if (body.amount !== undefined) {
    updates.amount = body.amount;
  }
  if (body.income_type !== undefined) {
    updates.income_type = body.income_type;
  }
  if (body.recurrence !== undefined) {
    updates.recurrence = body.recurrence;
  }
  if (body.month !== undefined) {
    updates.month = body.month;
  }
  if (body.year !== undefined) {
    updates.year = body.year;
  }
  if (body.notes !== undefined) {
    updates.notes = body.notes || null;
  }

  const { data, error } = await db
    .from("budget_income_sources")
    .update(updates)
    .eq("id", incomeId)
    .eq("user_id", userId)
    .select(
      "id, user_id, source_name, amount, income_type, recurrence, month, year, notes, created_at"
    )
    .single();

  throwIfError(error);

  if (!data) {
    throw new Error("Income source not found");
  }

  const row = data as BudgetIncomeSource;
  return { ...row, amount: Number(row.amount) };
}

export async function deleteIncome(
  db: SupabaseClient,
  userId: string,
  incomeId: string
): Promise<void> {
  const { error } = await db
    .from("budget_income_sources")
    .delete()
    .eq("id", incomeId)
    .eq("user_id", userId);

  throwIfError(error);
}

// ---- TRANSACTIONS ----

export async function queryTransactions(
  db: SupabaseClient,
  filters: TransactionFilter
): Promise<{ data: BudgetTransaction[]; total: number }> {
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
  const offset = Math.max(0, filters.offset ?? 0);

  let slugCategoryIds: string[] | null = null;
  if (filters.category_slug) {
    slugCategoryIds = await resolveCategoryIdsBySlug(
      db,
      filters.user_id,
      filters.category_slug
    );

    if (slugCategoryIds.length === 0) {
      return { data: [], total: 0 };
    }
  }

  const { startDate, endDateExclusive } =
    filters.month && filters.year
      ? monthBoundaries(filters.month, filters.year)
      : { startDate: "", endDateExclusive: "" };

  let countQuery = db
    .from("budget_transactions")
    .select("id", { head: true, count: "exact" })
    .eq("user_id", filters.user_id);

  if (filters.month && filters.year) {
    countQuery = countQuery
      .gte("date", startDate)
      .lt("date", endDateExclusive);
  }
  if (filters.date_from) {
    countQuery = countQuery.gte("date", filters.date_from);
  }
  if (filters.date_to) {
    countQuery = countQuery.lte("date", filters.date_to);
  }
  if (filters.category_id) {
    countQuery = countQuery.eq("category_id", filters.category_id);
  }
  if (slugCategoryIds) {
    countQuery = countQuery.in("category_id", slugCategoryIds);
  }
  if (filters.type) {
    countQuery = countQuery.eq("type", filters.type);
  }
  if (filters.description_contains) {
    countQuery = countQuery.ilike(
      "description",
      `%${filters.description_contains}%`
    );
  }
  if (filters.amount_min !== undefined) {
    countQuery = countQuery.gte("amount", filters.amount_min);
  }
  if (filters.amount_max !== undefined) {
    countQuery = countQuery.lte("amount", filters.amount_max);
  }

  const { count, error: countError } = await countQuery;
  throwIfError(countError);

  let dataQuery = db
    .from("budget_transactions")
    .select(
      "id, user_id, category_id, amount, type, date, description, raw_description, category_confidence, notes, created_at, category:budget_categories(id, user_id, name, slug, icon, color, is_system, is_active, aliases, sort_order)"
    )
    .eq("user_id", filters.user_id)
    .order("date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (filters.month && filters.year) {
    dataQuery = dataQuery.gte("date", startDate).lt("date", endDateExclusive);
  }
  if (filters.date_from) {
    dataQuery = dataQuery.gte("date", filters.date_from);
  }
  if (filters.date_to) {
    dataQuery = dataQuery.lte("date", filters.date_to);
  }
  if (filters.category_id) {
    dataQuery = dataQuery.eq("category_id", filters.category_id);
  }
  if (slugCategoryIds) {
    dataQuery = dataQuery.in("category_id", slugCategoryIds);
  }
  if (filters.type) {
    dataQuery = dataQuery.eq("type", filters.type);
  }
  if (filters.description_contains) {
    dataQuery = dataQuery.ilike("description", `%${filters.description_contains}%`);
  }
  if (filters.amount_min !== undefined) {
    dataQuery = dataQuery.gte("amount", filters.amount_min);
  }
  if (filters.amount_max !== undefined) {
    dataQuery = dataQuery.lte("amount", filters.amount_max);
  }

  const { data, error } = await dataQuery;
  throwIfError(error);

  const rows = (data ?? []) as BudgetTransactionRow[];
  return {
    data: rows.map(normalizeTransactionRow),
    total: count ?? 0,
  };
}

export async function createTransaction(
  db: SupabaseClient,
  userId: string,
  body: CreateTransactionBody & { category_confidence?: number | null }
): Promise<BudgetTransaction> {
  await assertCategoryAccessible(db, userId, body.category_id);

  const { data, error } = await db
    .from("budget_transactions")
    .insert({
      user_id: userId,
      category_id: body.category_id,
      amount: body.amount,
      type: body.type,
      date: body.date,
      description: body.description.trim(),
      raw_description: body.description,
      category_confidence: body.category_confidence ?? null,
      notes: body.notes ?? null,
    })
    .select(
      "id, user_id, category_id, amount, type, date, description, raw_description, category_confidence, notes, created_at, category:budget_categories(id, user_id, name, slug, icon, color, is_system, is_active, aliases, sort_order)"
    )
    .single();

  throwIfError(error);

  if (!data) {
    throw new Error("Failed to create transaction");
  }

  return normalizeTransactionRow(data as BudgetTransactionRow);
}

export async function updateTransaction(
  db: SupabaseClient,
  userId: string,
  txId: string,
  body: Partial<CreateTransactionBody>
): Promise<BudgetTransaction> {
  const updates: {
    category_id?: string;
    amount?: number;
    type?: "income" | "expense";
    date?: string;
    description?: string;
    raw_description?: string;
    notes?: string | null;
    updated_at: string;
  } = {
    updated_at: new Date().toISOString(),
  };

  if (body.category_id !== undefined) {
    await assertCategoryAccessible(db, userId, body.category_id);
    updates.category_id = body.category_id;
  }
  if (body.amount !== undefined) {
    updates.amount = body.amount;
  }
  if (body.type !== undefined) {
    updates.type = body.type;
  }
  if (body.date !== undefined) {
    updates.date = body.date;
  }
  if (body.description !== undefined) {
    updates.description = body.description.trim();
    updates.raw_description = body.description;
  }
  if (body.notes !== undefined) {
    updates.notes = body.notes || null;
  }

  const { data, error } = await db
    .from("budget_transactions")
    .update(updates)
    .eq("id", txId)
    .eq("user_id", userId)
    .select(
      "id, user_id, category_id, amount, type, date, description, raw_description, category_confidence, notes, created_at, category:budget_categories(id, user_id, name, slug, icon, color, is_system, is_active, aliases, sort_order)"
    )
    .single();

  throwIfError(error);

  if (!data) {
    throw new Error("Transaction not found");
  }

  return normalizeTransactionRow(data as BudgetTransactionRow);
}

export async function deleteTransaction(
  db: SupabaseClient,
  userId: string,
  txId: string
): Promise<void> {
  const { error } = await db
    .from("budget_transactions")
    .delete()
    .eq("id", txId)
    .eq("user_id", userId);

  throwIfError(error);
}

// ---- PLANS ----

export async function getBudgetPlans(
  db: SupabaseClient,
  userId: string,
  month: number,
  year: number
): Promise<BudgetPlan[]> {
  const { data, error } = await db
    .from("budget_plans")
    .select(
      "id, user_id, category_id, planned_amount, month, year, category:budget_categories(id, user_id, name, slug, icon, color, is_system, is_active, aliases, sort_order)"
    )
    .eq("user_id", userId)
    .eq("month", month)
    .eq("year", year);

  throwIfError(error);

  const rows = (data ?? []) as BudgetPlanRow[];
  return rows.map(normalizePlanRow);
}

export async function upsertBudgetPlan(
  db: SupabaseClient,
  userId: string,
  body: UpsertBudgetPlanBody
): Promise<BudgetPlan> {
  if (body.category_id) {
    await assertCategoryAccessible(db, userId, body.category_id);

    const { data, error } = await db
      .from("budget_plans")
      .upsert(
        {
          user_id: userId,
          category_id: body.category_id,
          planned_amount: body.planned_amount,
          month: body.month,
          year: body.year,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,category_id,month,year" }
      )
      .select(
        "id, user_id, category_id, planned_amount, month, year, category:budget_categories(id, user_id, name, slug, icon, color, is_system, is_active, aliases, sort_order)"
      )
      .single();

    throwIfError(error);

    if (!data) {
      throw new Error("Failed to upsert budget plan");
    }

    return normalizePlanRow(data as BudgetPlanRow);
  }

  const { data: existing, error: existingError } = await db
    .from("budget_plans")
    .select("id")
    .eq("user_id", userId)
    .eq("month", body.month)
    .eq("year", body.year)
    .is("category_id", null)
    .limit(1)
    .single();

  if (existingError && existingError.code !== "PGRST116") {
    throwIfError(existingError);
  }

  if (existing?.id) {
    const { data, error } = await db
      .from("budget_plans")
      .update({
        planned_amount: body.planned_amount,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .eq("user_id", userId)
      .select(
        "id, user_id, category_id, planned_amount, month, year, category:budget_categories(id, user_id, name, slug, icon, color, is_system, is_active, aliases, sort_order)"
      )
      .single();

    throwIfError(error);

    if (!data) {
      throw new Error("Failed to update total budget cap");
    }

    return normalizePlanRow(data as BudgetPlanRow);
  }

  const { data, error } = await db
    .from("budget_plans")
    .insert({
      user_id: userId,
      category_id: null,
      planned_amount: body.planned_amount,
      month: body.month,
      year: body.year,
    })
    .select(
      "id, user_id, category_id, planned_amount, month, year, category:budget_categories(id, user_id, name, slug, icon, color, is_system, is_active, aliases, sort_order)"
    )
    .single();

  throwIfError(error);

  if (!data) {
    throw new Error("Failed to create total budget cap");
  }

  return normalizePlanRow(data as BudgetPlanRow);
}

// ---- SAVINGS GOALS ----

export async function getSavingsGoals(
  db: SupabaseClient,
  userId: string
): Promise<SavingsGoal[]> {
  const { data, error } = await db
    .from("budget_savings_goals")
    .select(
      "id, user_id, goal_name, target_amount, current_amount, target_date, is_active, created_at"
    )
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  throwIfError(error);

  const rows = (data ?? []) as SavingsGoal[];
  return rows.map((row) => ({
    ...row,
    target_amount: Number(row.target_amount),
    current_amount: Number(row.current_amount),
  }));
}

export async function createSavingsGoal(
  db: SupabaseClient,
  userId: string,
  body: CreateSavingsGoalBody
): Promise<SavingsGoal> {
  const { data, error } = await db
    .from("budget_savings_goals")
    .insert({
      user_id: userId,
      goal_name: body.goal_name.trim(),
      target_amount: body.target_amount,
      current_amount: body.current_amount ?? 0,
      target_date: body.target_date ?? null,
      is_active: true,
    })
    .select(
      "id, user_id, goal_name, target_amount, current_amount, target_date, is_active, created_at"
    )
    .single();

  throwIfError(error);

  if (!data) {
    throw new Error("Failed to create savings goal");
  }

  const row = data as SavingsGoal;
  return {
    ...row,
    target_amount: Number(row.target_amount),
    current_amount: Number(row.current_amount),
  };
}

export async function updateSavingsGoal(
  db: SupabaseClient,
  userId: string,
  goalId: string,
  body: Partial<CreateSavingsGoalBody & { current_amount: number }>
): Promise<SavingsGoal> {
  const updates: {
    goal_name?: string;
    target_amount?: number;
    current_amount?: number;
    target_date?: string | null;
    updated_at: string;
  } = {
    updated_at: new Date().toISOString(),
  };

  if (body.goal_name !== undefined) {
    updates.goal_name = body.goal_name.trim();
  }
  if (body.target_amount !== undefined) {
    updates.target_amount = body.target_amount;
  }
  if (body.current_amount !== undefined) {
    updates.current_amount = body.current_amount;
  }
  if (body.target_date !== undefined) {
    updates.target_date = body.target_date || null;
  }

  const { data, error } = await db
    .from("budget_savings_goals")
    .update(updates)
    .eq("id", goalId)
    .eq("user_id", userId)
    .select(
      "id, user_id, goal_name, target_amount, current_amount, target_date, is_active, created_at"
    )
    .single();

  throwIfError(error);

  if (!data) {
    throw new Error("Savings goal not found");
  }

  const row = data as SavingsGoal;
  return {
    ...row,
    target_amount: Number(row.target_amount),
    current_amount: Number(row.current_amount),
  };
}

export async function deleteSavingsGoal(
  db: SupabaseClient,
  userId: string,
  goalId: string
): Promise<void> {
  const { error } = await db
    .from("budget_savings_goals")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", goalId)
    .eq("user_id", userId);

  throwIfError(error);
}

// ---- DASHBOARD AGGREGATION ----

export async function checkAlerts(
  categoryBreakdown: CategoryBreakdown[],
  totalExpenses: number,
  totalMonthlyCapPlan: number | null,
  prevMonthsData: { category_slug: string; avg_amount: number }[]
): Promise<BudgetAlert[]> {
  const alerts: BudgetAlert[] = [];
  const prevMap = new Map<string, number>(
    prevMonthsData.map((item) => [item.category_slug, item.avg_amount])
  );

  for (const item of categoryBreakdown) {
    const planned = item.planned;
    const actual = item.actual;

    if (planned > 0 && actual > planned) {
      alerts.push({
        type: "category_exceeded",
        severity: "danger",
        category_slug: item.category.slug,
        message: `You've exceeded your ${item.category.name} budget (${formatPKR(actual)} / ${formatPKR(planned)})`,
      });
    }

    if (planned > 0 && actual >= planned * 0.8 && actual <= planned) {
      const pct = Math.round((actual / planned) * 100);
      alerts.push({
        type: "category_80pct",
        severity: "warning",
        category_slug: item.category.slug,
        message: `You've used ${pct}% of your ${item.category.name} budget`,
      });
    }

    const prevAvg = prevMap.get(item.category.slug) ?? 0;
    if (prevAvg > 0 && actual > prevAvg * 1.5) {
      alerts.push({
        type: "unusual_spike",
        severity: "warning",
        category_slug: item.category.slug,
        message: `Unusual ${item.category.name} spending - ${formatPKR(actual)} vs ${formatPKR(prevAvg)} avg`,
      });
    }
  }

  if (totalMonthlyCapPlan && totalMonthlyCapPlan > 0) {
    if (totalExpenses > totalMonthlyCapPlan) {
      alerts.push({
        type: "monthly_cap_exceeded",
        severity: "danger",
        message: `Monthly budget cap exceeded (${formatPKR(totalExpenses)} / ${formatPKR(totalMonthlyCapPlan)})`,
      });
    } else if (totalExpenses >= totalMonthlyCapPlan * 0.8) {
      const pct = Math.round((totalExpenses / totalMonthlyCapPlan) * 100);
      alerts.push({
        type: "monthly_cap_80pct",
        severity: "warning",
        message: `You've used ${pct}% of your monthly budget`,
      });
    }
  }

  return alerts;
}

export async function getPrevMonthsAvgByCategory(
  db: SupabaseClient,
  userId: string,
  currentMonth: number,
  currentYear: number,
  lookback: number = 3
): Promise<{ category_slug: string; avg_amount: number }[]> {
  const currentMonthStart = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
  const lookbackStart = new Date(currentMonthStart);
  lookbackStart.setUTCMonth(lookbackStart.getUTCMonth() - lookback);

  const { data, error } = await db
    .from("budget_transactions")
    .select("category_id, amount, date")
    .eq("user_id", userId)
    .eq("type", "expense")
    .gte("date", lookbackStart.toISOString().slice(0, 10))
    .lt("date", currentMonthStart.toISOString().slice(0, 10));

  throwIfError(error);

  const rows = (data ?? []) as Array<{
    category_id: string;
    amount: number;
    date: string;
  }>;

  const byCategoryMonth = new Map<string, number>();
  for (const row of rows) {
    const date = new Date(`${row.date}T00:00:00Z`);
    const key = `${row.category_id}:${date.getUTCFullYear()}-${String(
      date.getUTCMonth() + 1
    ).padStart(2, "0")}`;
    byCategoryMonth.set(key, (byCategoryMonth.get(key) ?? 0) + Number(row.amount));
  }

  const byCategory = new Map<string, number[]>();
  for (const [key, total] of byCategoryMonth.entries()) {
    const categoryId = key.split(":")[0];
    const list = byCategory.get(categoryId) ?? [];
    list.push(total);
    byCategory.set(categoryId, list);
  }

  const categoryIds = Array.from(byCategory.keys());
  if (categoryIds.length === 0) {
    return [];
  }

  const { data: categories, error: categoriesError } = await db
    .from("budget_categories")
    .select("id, slug")
    .in("id", categoryIds);

  throwIfError(categoriesError);

  const slugById = new Map<string, string>(
    ((categories ?? []) as Array<{ id: string; slug: string }>).map((item) => [
      item.id,
      item.slug,
    ])
  );

  const output: { category_slug: string; avg_amount: number }[] = [];
  for (const [categoryId, totals] of byCategory.entries()) {
    const slug = slugById.get(categoryId);
    if (!slug || totals.length === 0) {
      continue;
    }

    const avg = totals.reduce((sum, val) => sum + val, 0) / totals.length;
    output.push({ category_slug: slug, avg_amount: avg });
  }

  return output;
}

export async function getDashboard(
  db: SupabaseClient,
  userId: string,
  month: number,
  year: number
): Promise<BudgetDashboardData> {
  const { startDate, endDateExclusive } = monthBoundaries(month, year);

  const { data: incomeRows, error: incomeError } = await db
    .from("budget_income_sources")
    .select("amount")
    .eq("user_id", userId)
    .eq("month", month)
    .eq("year", year);

  throwIfError(incomeError);

  const { data: incomeTxRows, error: incomeTxError } = await db
    .from("budget_transactions")
    .select("amount")
    .eq("user_id", userId)
    .eq("type", "income")
    .gte("date", startDate)
    .lt("date", endDateExclusive);

  throwIfError(incomeTxError);

  const totalIncome = 
    ((incomeRows ?? []) as Array<{ amount: number }>).reduce(
      (sum, row) => sum + Number(row.amount),
      0
    ) +
    ((incomeTxRows ?? []) as Array<{ amount: number }>).reduce(
      (sum, row) => sum + Number(row.amount),
      0
    );

  const { data: expenseRows, error: expenseError } = await db
    .from("budget_transactions")
    .select("category_id, amount")
    .eq("user_id", userId)
    .eq("type", "expense")
    .gte("date", startDate)
    .lt("date", endDateExclusive);

  throwIfError(expenseError);

  const expenseItems = (expenseRows ?? []) as Array<{
    category_id: string;
    amount: number;
  }>;

  const totalExpenses = expenseItems.reduce(
    (sum, row) => sum + Number(row.amount),
    0
  );

  const categories = await getCategories(db, userId);
  const plans = await getBudgetPlans(db, userId, month, year);
  const planMap = buildCategoryPlanMap(plans);

  const actualByCategory = new Map<string, number>();
  for (const item of expenseItems) {
    actualByCategory.set(
      item.category_id,
      (actualByCategory.get(item.category_id) ?? 0) + Number(item.amount)
    );
  }

  const categoryBreakdown: CategoryBreakdown[] = categories
    .map((category) => {
      const actual = actualByCategory.get(category.id) ?? 0;
      const planned = planMap.get(category.id) ?? 0;
      return {
        category,
        actual,
        planned,
        percentage: totalExpenses > 0 ? (actual / totalExpenses) * 100 : 0,
        over_budget: planned > 0 && actual > planned,
      };
    })
    .sort((a, b) => b.actual - a.actual);

  const totalCap = plans.find((plan) => plan.category_id === null) ?? null;
  const totalMonthlyCapPlan = totalCap ? totalCap.planned_amount : null;

  const savings = totalIncome - totalExpenses;
  const savingsRate = totalIncome > 0 ? (savings / totalIncome) * 100 : 0;
  const currentDayForBurnRate = getCurrentDayForBurnRate(month, year);
  const burnRate = totalExpenses / currentDayForBurnRate;

  const savingsGoals = await getSavingsGoals(db, userId);
  const goalsWithDate = savingsGoals.filter((goal) => goal.target_date);
  const goal = goalsWithDate.length
    ? goalsWithDate.sort((a, b) => {
        const aDate = a.target_date ? Date.parse(a.target_date) : Number.MAX_SAFE_INTEGER;
        const bDate = b.target_date ? Date.parse(b.target_date) : Number.MAX_SAFE_INTEGER;
        return aDate - bDate;
      })[0]
    : savingsGoals[0] ?? null;

  let daysRemaining = getDaysRemainingInMonth(month, year);
  let dailyAllowance: number | null = null;

  if (goal) {
    if (goal.target_date) {
      daysRemaining = daysBetweenInclusive(new Date(), new Date(goal.target_date));
    }
    const amountNeededForGoal = goal.target_amount - goal.current_amount;
    const budgetRemaining = totalIncome - totalExpenses - amountNeededForGoal;
    dailyAllowance = daysRemaining > 0 ? budgetRemaining / daysRemaining : null;
  } else {
    const budgetRemaining = totalIncome - totalExpenses;
    dailyAllowance = daysRemaining > 0 ? budgetRemaining / daysRemaining : null;
  }

  const prevMonthsData = await getPrevMonthsAvgByCategory(
    db,
    userId,
    month,
    year,
    3
  );

  const alerts = await checkAlerts(
    categoryBreakdown,
    totalExpenses,
    totalMonthlyCapPlan,
    prevMonthsData
  );

  return {
    month,
    year,
    total_income: totalIncome,
    total_expenses: totalExpenses,
    savings,
    savings_rate: savingsRate,
    burn_rate: burnRate,
    category_breakdown: categoryBreakdown,
    alerts,
    daily_allowance: dailyAllowance,
    days_remaining: daysRemaining,
  };
}

// ---- HISTORY ----

export async function getHistory(
  db: SupabaseClient,
  userId: string,
  months: number = 6
): Promise<MonthlyHistoryPoint[]> {
  const count = Math.max(1, months);
  const now = new Date();

  const points: MonthlyHistoryPoint[] = [];

  for (let i = count - 1; i >= 0; i -= 1) {
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const year = target.getUTCFullYear();
    const month = target.getUTCMonth() + 1;

    const { data: incomeRows, error: incomeError } = await db
      .from("budget_income_sources")
      .select("amount")
      .eq("user_id", userId)
      .eq("month", month)
      .eq("year", year);

    throwIfError(incomeError);

    const { startDate, endDateExclusive } = monthBoundaries(month, year);

    const { data: incomeTxRows, error: incomeTxError } = await db
      .from("budget_transactions")
      .select("amount")
      .eq("user_id", userId)
      .eq("type", "income")
      .gte("date", startDate)
      .lt("date", endDateExclusive);

    throwIfError(incomeTxError);

    const totalIncome = 
      ((incomeRows ?? []) as Array<{ amount: number }>).reduce(
        (sum, row) => sum + Number(row.amount),
        0
      ) +
      ((incomeTxRows ?? []) as Array<{ amount: number }>).reduce(
        (sum, row) => sum + Number(row.amount),
        0
      );

    const { data: expenseRows, error: expenseError } = await db
      .from("budget_transactions")
      .select("amount")
      .eq("user_id", userId)
      .eq("type", "expense")
      .gte("date", startDate)
      .lt("date", endDateExclusive);

    throwIfError(expenseError);

    const totalExpenses = ((expenseRows ?? []) as Array<{ amount: number }>).reduce(
      (sum, row) => sum + Number(row.amount),
      0
    );

    const savings = totalIncome - totalExpenses;
    const savingsRate = totalIncome > 0 ? (savings / totalIncome) * 100 : 0;

    points.push({
      month,
      year,
      total_income: totalIncome,
      total_expenses: totalExpenses,
      savings,
      savings_rate: savingsRate,
    });
  }

  return points;
}
