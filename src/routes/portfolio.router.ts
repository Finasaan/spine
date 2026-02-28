import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.middleware";
import { portfolioController } from "../controllers/portfolio.controller";

/**
 * Portfolio Router
 * Base path: /api/portfolio
 *
 * All routes require authentication.
 *
 * Endpoints:
 *   GET    /                          - List user's portfolios
 *   POST   /                          - Create portfolio
 *   GET    /:id                       - Get portfolio with holdings
 *   PUT    /:id                       - Update portfolio name/description
 *   DELETE /:id                       - Delete portfolio (cascades holdings)
 *   GET    /:id/summary               - Portfolio dashboard (value, P/L, allocation)
 *   POST   /:id/holdings              - Add holding (stock or fund)
 *   PUT    /:id/holdings/:holdingId   - Update holding
 *   DELETE /:id/holdings/:holdingId   - Remove holding
 */
const portfolioRouter = new Hono<{ Bindings: CloudflareBindings }>();

// All portfolio routes require auth
portfolioRouter.use("/*", authMiddleware);

// Portfolio CRUD
portfolioRouter.get("/", portfolioController.listPortfolios);
portfolioRouter.post("/", portfolioController.createPortfolio);
portfolioRouter.get("/:id", portfolioController.getPortfolio);
portfolioRouter.put("/:id", portfolioController.updatePortfolio);
portfolioRouter.delete("/:id", portfolioController.deletePortfolio);

// Portfolio summary/dashboard
portfolioRouter.get("/:id/summary", portfolioController.getPortfolioSummary);

// Holdings CRUD
portfolioRouter.post("/:id/holdings", portfolioController.addHolding);
portfolioRouter.put("/:id/holdings/:holdingId", portfolioController.updateHolding);
portfolioRouter.delete("/:id/holdings/:holdingId", portfolioController.deleteHolding);

export { portfolioRouter };
