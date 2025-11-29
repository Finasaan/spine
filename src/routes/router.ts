import { Hono } from "hono";
import { psxRouter } from "./psx.router";
import { mfsRouter } from "./mfs.router";
import { sectorsRouter } from "./sectors.router";
import { healthRouter } from "./health.router";

/**
 * Main Router - Registers all route modules
 */
const router = new Hono<{ Bindings: CloudflareBindings }>();

// Health and utility routes (at /api level)
router.route("/api", healthRouter);

// Domain-specific routes
router.route("/api/psx", psxRouter);
router.route("/api/mfs", mfsRouter);
router.route("/api/sectors", sectorsRouter);

// Legacy routes for backward compatibility
// These map old endpoints to new structure
router.get("/api/companies", (c) => c.redirect("/api/psx/companies"));
router.get("/api/mutual-funds", (c) => c.redirect("/api/mfs/funds"));

export { router };
