import { Hono } from "hono";
import { psxRouter } from "./psx.router";
import { mfsRouter } from "./mfs.router";
import { sectorsRouter } from "./sectors.router";
import { healthRouter } from "./health.router";
import { authRouter } from "./auth.router";
import { profileRouter } from "./profile.router";
import { chatbotRouter } from "./chatbot.router";

/**
 * Main Router - Registers all route modules
 * Routes are registered for both production and preview environments
 */
const router = new Hono<{ Bindings: CloudflareBindings }>();

// Production routes (at /api level)
router.route("/api", healthRouter);
router.route("/api/auth", authRouter);
router.route("/api/profile", profileRouter);
router.route("/api/psx", psxRouter);
router.route("/api/mfs", mfsRouter);
router.route("/api/sectors", sectorsRouter);
router.route("/api/chatbot", chatbotRouter);

// Preview routes (at /api/preview level)
router.route("/api/preview", healthRouter);
router.route("/api/preview/auth", authRouter);
router.route("/api/preview/profile", profileRouter);
router.route("/api/preview/psx", psxRouter);
router.route("/api/preview/mfs", mfsRouter);
router.route("/api/preview/sectors", sectorsRouter);
router.route("/api/preview/chatbot", chatbotRouter);

export { router };
