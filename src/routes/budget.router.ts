import { Hono } from "hono";
import { authMiddleware } from "../middleware";
import * as Budget from "../controllers/budget.controller";

const budgetRouter = new Hono<{ Bindings: CloudflareBindings }>();
budgetRouter.use("/*", authMiddleware);

// Categories
budgetRouter.get("/categories", Budget.getCategories);
budgetRouter.post("/categories", Budget.createCategory);
budgetRouter.put("/categories/:id", Budget.updateCategory);
budgetRouter.delete("/categories/:id", Budget.deleteCategory);

// Income
budgetRouter.get("/income", Budget.getIncome);
budgetRouter.post("/income", Budget.createIncome);
budgetRouter.put("/income/:id", Budget.updateIncome);
budgetRouter.delete("/income/:id", Budget.deleteIncome);

// Transactions
budgetRouter.get("/transactions", Budget.getTransactions);
budgetRouter.post("/transactions", Budget.createTransaction);
budgetRouter.put("/transactions/:id", Budget.updateTransaction);
budgetRouter.delete("/transactions/:id", Budget.deleteTransaction);
budgetRouter.get("/classify", Budget.handleClassifyTransaction);

// Budget plans
budgetRouter.get("/plans", Budget.getBudgetPlans);
budgetRouter.post("/plans", Budget.upsertBudgetPlan);

// Dashboard
budgetRouter.get("/dashboard", Budget.getDashboard);

// History
budgetRouter.get("/history", Budget.getHistory);

// Savings goals
budgetRouter.get("/savings/goals", Budget.getSavingsGoals);
budgetRouter.post("/savings/goals", Budget.createSavingsGoal);
budgetRouter.put("/savings/goals/:id", Budget.updateSavingsGoal);
budgetRouter.delete("/savings/goals/:id", Budget.deleteSavingsGoal);

export { budgetRouter };
