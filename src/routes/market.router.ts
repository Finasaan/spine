import { Hono } from "hono";
import { marketController } from "../controllers/market.controller";

/**
 * Market Router
 * Base path: /api/market
 *
 * All routes are public (no auth required) — market data is public information.
 *
 * Endpoints:
 *   GET  /summary  - Get latest market summary (KSE-100, KSE-30)
 *   POST /ingest   - Force-fetch and cache market data
 */
const marketRouter = new Hono<{ Bindings: CloudflareBindings }>();

marketRouter.get("/summary", marketController.getSummary);
marketRouter.post("/ingest", marketController.ingest);

export { marketRouter };
