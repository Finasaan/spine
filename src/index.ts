import { Hono } from "hono";
import { cors } from "hono/cors";
import { router } from "./routes";

/**
 * Spine API - Finasaan Backend Service
 * Main application entry point
 */
const app = new Hono<{ Bindings: CloudflareBindings }>();

// ============================================
// Global Middleware
// ============================================

// Enable CORS for cross-origin requests
app.use(
  "/*",
  cors({
    origin: ["http://localhost:3000", "https://*.finasaan.com"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Strip /preview prefix for preview environment routes
app.use("/*", (c, next) => {
  const path = c.req.path;
  if (path.startsWith("/api/preview/")) {
    // Remove the /preview segment from the path
    const originalPath = path.replace("/api/preview", "/api");
    c.req.raw = new Request(new URL(originalPath, c.req.url).toString(), c.req.raw);
  }
  return next();
});

// ============================================
// Routes
// ============================================

// Mount all routes from router
app.route("/", router);

// ============================================
// 404 Handler
// ============================================

app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: "Not Found",
      path: c.req.path,
      timestamp: new Date().toISOString(),
    },
    404
  );
});

// ============================================
// Error Handler
// ============================================

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(
    {
      success: false,
      error: "Internal Server Error",
      message: err.message,
      timestamp: new Date().toISOString(),
    },
    500
  );
});

export default app;
