import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.middleware";
import { watchlistController } from "../controllers/watchlist.controller";

/**
 * Watchlist Router
 * Base path: /api/watchlist
 *
 * All routes require authentication.
 *
 * Endpoints:
 *   GET    /             - List user's watchlist (query: type=stock|fund|all)
 *   POST   /             - Add to watchlist
 *   DELETE /:id          - Remove by watchlist entry ID
 *   DELETE /asset/:assetId - Remove by asset ID (query: type=stock|fund)
 *   GET    /check/:assetId - Check if asset is watchlisted (query: type=stock|fund)
 */
const watchlistRouter = new Hono<{ Bindings: CloudflareBindings }>();

// All watchlist routes require auth
watchlistRouter.use("/*", authMiddleware);

watchlistRouter.get("/", watchlistController.getWatchlist);
watchlistRouter.post("/", watchlistController.addToWatchlist);
watchlistRouter.delete("/:id", watchlistController.removeFromWatchlist);
watchlistRouter.delete("/asset/:assetId", watchlistController.removeByAssetId);
watchlistRouter.get("/check/:assetId", watchlistController.checkWatchlisted);

export { watchlistRouter };
