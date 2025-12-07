import { Hono } from "hono";
import { psxRouter } from "./psx.router";
import { mfsRouter } from "./mfs.router";
import { sectorsRouter } from "./sectors.router";
import { healthRouter } from "./health.router";

/**
 * Helper function to conditionally add /preview prefix based on environment
 * @param path - The base route path
 * @param isPreview - Whether this is a preview environment
 * @returns The path with /preview prefix if isPreview is true, otherwise the original path
 */
function getRoutePath(path: string, isPreview: boolean): string {
  if (isPreview && !path.startsWith("/api/preview")) {
    return path.replace("/api", "/api/preview");
  }
  return path;
}

/**
 * Main Router - Registers all route modules
 */
const router = new Hono<{ Bindings: CloudflareBindings }>();

// Wrangler exposes an `ENVIRONMENT` global for environments (see wrangler docs)
// Declare it so TypeScript doesn't complain and read it safely.
declare const ENVIRONMENT: string | undefined;

// Determine if this is a preview environment. Wrangler sets `ENVIRONMENT` to
// the environment name (for preview builds this is typically "preview").
const isPreview =
  typeof ENVIRONMENT !== "undefined" && ENVIRONMENT === "preview";

// console.log("ENVIRONMENT:", ENVIRONMENT);

// Export the helper so other modules can re-use the same logic if needed.
export { getRoutePath };

// Health and utility routes (at /api level)
router.route(getRoutePath("/api", isPreview), healthRouter);

// Domain-specific routes
router.route(getRoutePath("/api/psx", isPreview), psxRouter);
router.route(getRoutePath("/api/mfs", isPreview), mfsRouter);
router.route(getRoutePath("/api/sectors", isPreview), sectorsRouter);

export { router };
