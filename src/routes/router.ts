import { Hono } from "hono";
import { psxRouter } from "./psx.router";
import { mfsRouter } from "./mfs.router";
import { sectorsRouter } from "./sectors.router";
import { healthRouter } from "./health.router";
import { authRouter } from "./auth/auth.router";
import { profileRouter } from "./profile.router";
import { chatbotRouter } from "./chatbot.router";
import { watchlistRouter } from "./watchlist.router";
import { portfolioRouter } from "./portfolio.router";
import { marketRouter } from "./market.router";
import { insuranceRouter } from "./insurance.router";

/**
 * Main Router - Registers all route modules.
 * Routes are registered for both production and preview environments.
 */
const router = new Hono<{ Bindings: CloudflareBindings }>();

// Production routes
router.route("/api", healthRouter);
router.route("/api/auth", authRouter);
router.route("/api/profile", profileRouter);
router.route("/api/psx", psxRouter);
router.route("/api/mfs", mfsRouter);
router.route("/api/sectors", sectorsRouter);
router.route("/api/chatbot", chatbotRouter);
router.route("/api/watchlist", watchlistRouter);
router.route("/api/portfolio", portfolioRouter);
router.route("/api/market", marketRouter);
router.route("/api/insurance", insuranceRouter);

// Preview routes
router.route("/api/preview", healthRouter);
router.route("/api/preview/auth", authRouter);
router.route("/api/preview/profile", profileRouter);
router.route("/api/preview/psx", psxRouter);
router.route("/api/preview/mfs", mfsRouter);
router.route("/api/preview/sectors", sectorsRouter);
router.route("/api/preview/chatbot", chatbotRouter);
router.route("/api/preview/watchlist", watchlistRouter);
router.route("/api/preview/portfolio", portfolioRouter);
router.route("/api/preview/market", marketRouter);
router.route("/api/preview/insurance", insuranceRouter);

export { router };
