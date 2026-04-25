import { AppContext, errorResponse, successResponse } from "../types";
import { getSupabaseAdminClient } from "../db";
import * as BudgetService from "../services/budget.service";
import {
  CreateCategoryBody,
  CreateIncomeBody,
  CreateSavingsGoalBody,
  CreateTransactionBody,
  TransactionFilter,
  UpsertBudgetPlanBody,
} from "../types/budget.types";

function parseMonth(value: string | undefined): number {
  const fallback = new Date().getMonth() + 1;
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseYear(value: string | undefined): number {
  const fallback = new Date().getFullYear();
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function getCategories(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const data = await BudgetService.getCategories(db, user.id);
    return c.json(successResponse(data));
  } catch (err) {
    return c.json(errorResponse(err), 500);
  }
}

export async function createCategory(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const body = (await c.req.json()) as CreateCategoryBody;
    const data = await BudgetService.createCategory(db, user.id, body);
    return c.json(successResponse(data), 201);
  } catch (err) {
    return c.json(errorResponse(err), 400);
  }
}

export async function updateCategory(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const id = c.req.param("id");
    const body = (await c.req.json()) as Partial<CreateCategoryBody>;
    const data = await BudgetService.updateCategory(db, user.id, id, body);
    return c.json(successResponse(data));
  } catch (err) {
    return c.json(errorResponse(err), 400);
  }
}

export async function deleteCategory(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const id = c.req.param("id");
    await BudgetService.deleteCategory(db, user.id, id);
    return c.json(successResponse({ deleted: true }));
  } catch (err) {
    return c.json(errorResponse(err), 400);
  }
}

export async function getIncome(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const month = parseMonth(c.req.query("month"));
    const year = parseYear(c.req.query("year"));
    const data = await BudgetService.getIncome(db, user.id, month, year);
    return c.json(successResponse(data));
  } catch (err) {
    return c.json(errorResponse(err), 500);
  }
}

export async function createIncome(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const body = (await c.req.json()) as CreateIncomeBody;
    const data = await BudgetService.createIncome(db, user.id, body);
    return c.json(successResponse(data), 201);
  } catch (err) {
    return c.json(errorResponse(err), 400);
  }
}

export async function updateIncome(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const id = c.req.param("id");
    const body = (await c.req.json()) as Partial<CreateIncomeBody>;
    const data = await BudgetService.updateIncome(db, user.id, id, body);
    return c.json(successResponse(data));
  } catch (err) {
    return c.json(errorResponse(err), 400);
  }
}

export async function deleteIncome(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const id = c.req.param("id");
    await BudgetService.deleteIncome(db, user.id, id);
    return c.json(successResponse({ deleted: true }));
  } catch (err) {
    return c.json(errorResponse(err), 400);
  }
}

export async function getTransactions(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");

    const month = c.req.query("month");
    const year = c.req.query("year");
    const limit = c.req.query("limit");
    const offset = c.req.query("offset");

    const filters: TransactionFilter = {
      user_id: user.id,
      category_id: c.req.query("category_id") || undefined,
      category_slug: c.req.query("category_slug") || undefined,
      type: (c.req.query("type") as "income" | "expense" | undefined) ||
        undefined,
      description_contains: c.req.query("description_contains") || undefined,
      date_from: c.req.query("date_from") || undefined,
      date_to: c.req.query("date_to") || undefined,
      amount_min: c.req.query("amount_min")
        ? Number(c.req.query("amount_min"))
        : undefined,
      amount_max: c.req.query("amount_max")
        ? Number(c.req.query("amount_max"))
        : undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    };

    if (month && year) {
      filters.month = parseMonth(month);
      filters.year = parseYear(year);
    }

    const data = await BudgetService.queryTransactions(db, filters);
    return c.json(successResponse(data));
  } catch (err) {
    return c.json(errorResponse(err), 400);
  }
}

export async function createTransaction(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const body = (await c.req.json()) as CreateTransactionBody;
    const data = await BudgetService.createTransaction(db, user.id, body);
    return c.json(successResponse(data), 201);
  } catch (err) {
    return c.json(errorResponse(err), 400);
  }
}

export async function updateTransaction(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const id = c.req.param("id");
    const body = (await c.req.json()) as Partial<CreateTransactionBody>;
    const data = await BudgetService.updateTransaction(db, user.id, id, body);
    return c.json(successResponse(data));
  } catch (err) {
    return c.json(errorResponse(err), 400);
  }
}

export async function deleteTransaction(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const id = c.req.param("id");
    await BudgetService.deleteTransaction(db, user.id, id);
    return c.json(successResponse({ deleted: true }));
  } catch (err) {
    return c.json(errorResponse(err), 400);
  }
}

export async function getBudgetPlans(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const month = parseMonth(c.req.query("month"));
    const year = parseYear(c.req.query("year"));
    const data = await BudgetService.getBudgetPlans(db, user.id, month, year);
    return c.json(successResponse(data));
  } catch (err) {
    return c.json(errorResponse(err), 500);
  }
}

export async function upsertBudgetPlan(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const body = (await c.req.json()) as UpsertBudgetPlanBody;
    const data = await BudgetService.upsertBudgetPlan(db, user.id, body);
    return c.json(successResponse(data));
  } catch (err) {
    return c.json(errorResponse(err), 400);
  }
}

export async function getDashboard(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const month = parseMonth(c.req.query("month"));
    const year = parseYear(c.req.query("year"));
    const data = await BudgetService.getDashboard(db, user.id, month, year);
    return c.json(successResponse(data));
  } catch (err) {
    return c.json(errorResponse(err), 500);
  }
}

export async function getHistory(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const months = parsePositiveInt(c.req.query("months"), 6);
    const data = await BudgetService.getHistory(db, user.id, months);
    return c.json(successResponse(data));
  } catch (err) {
    return c.json(errorResponse(err), 500);
  }
}

export async function getSavingsGoals(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const data = await BudgetService.getSavingsGoals(db, user.id);
    return c.json(successResponse(data));
  } catch (err) {
    return c.json(errorResponse(err), 500);
  }
}

export async function createSavingsGoal(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const body = (await c.req.json()) as CreateSavingsGoalBody;
    const data = await BudgetService.createSavingsGoal(db, user.id, body);
    return c.json(successResponse(data), 201);
  } catch (err) {
    return c.json(errorResponse(err), 400);
  }
}

export async function updateSavingsGoal(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const id = c.req.param("id");
    const body = (await c.req.json()) as Partial<
      CreateSavingsGoalBody & { current_amount: number }
    >;
    const data = await BudgetService.updateSavingsGoal(db, user.id, id, body);
    return c.json(successResponse(data));
  } catch (err) {
    return c.json(errorResponse(err), 400);
  }
}

export async function deleteSavingsGoal(c: AppContext) {
  try {
    const db = await getSupabaseAdminClient(c.env);
    const user = c.get("user");
    const id = c.req.param("id");
    await BudgetService.deleteSavingsGoal(db, user.id, id);
    return c.json(successResponse({ deleted: true }));
  } catch (err) {
    return c.json(errorResponse(err), 400);
  }
}
