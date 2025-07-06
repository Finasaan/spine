import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Enable CORS for cross-origin requests
app.use(
  "/*",
  cors({
    origin: ["http://localhost:3000", "https://*.finasaan.com"],
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

app.get("/api/message", (c) => {
  return c.text("Hello Hono!");
});

// Simple financial tips API endpoint
app.get("/api/financial-tips", (c) => {
  const tips = [
    {
      id: 1,
      title: "Start an Emergency Fund",
      description: "Save 3-6 months of expenses for unexpected situations",
      category: "savings",
      priority: "high",
    },
    {
      id: 2,
      title: "Track Your Expenses",
      description:
        "Monitor where your money goes each month to identify saving opportunities",
      category: "budgeting",
      priority: "high",
    },
    {
      id: 3,
      title: "Invest Early",
      description:
        "Start investing as early as possible to benefit from compound interest",
      category: "investing",
      priority: "medium",
    },
  ];

  return c.json({
    success: true,
    data: tips,
    timestamp: new Date().toISOString(),
  });
});

// Health check endpoint
app.get("/api/health", (c) => {
  return c.json({
    status: "healthy",
    service: "spine",
    timestamp: new Date().toISOString(),
  });
});

export default app;
