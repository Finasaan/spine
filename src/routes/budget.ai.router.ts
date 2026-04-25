import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.middleware";
import { handleNLQuery, handleGetInsights, handleGetSuggestions } from "../controllers/budget.ai.controller";

const budgetAIRouter = new Hono<{ Bindings: CloudflareBindings }>();

budgetAIRouter.use("*", authMiddleware);

budgetAIRouter.post("/query",      handleNLQuery);
budgetAIRouter.get("/insights",    handleGetInsights);
budgetAIRouter.get("/suggestions", handleGetSuggestions);

export { budgetAIRouter };
