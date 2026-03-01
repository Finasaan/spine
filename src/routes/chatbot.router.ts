/**
 * Chatbot Router — FinasaanGPT v2
 * All routes require authentication via authMiddleware.
 */

import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.middleware";
import {
  handleStream,
  handleUploadAttachment,
  handleGetModels,
  handleGetSessions,
  handleGetSession,
  handleDeleteSession,
} from "../controllers/chatbot.controller";

const chatbotRouter = new Hono<{ Bindings: CloudflareBindings }>();

// ============================================
// Public Routes
// ============================================

// Available models (no auth needed — used on the login page / marketing)
chatbotRouter.get("/models", handleGetModels);

// ============================================
// Authenticated Routes
// ============================================

chatbotRouter.use("/*", authMiddleware);

// Main streaming endpoint
chatbotRouter.post("/stream", handleStream);

// Conversation-scoped PDF attachment upload
chatbotRouter.post("/upload-attachment", handleUploadAttachment);

// Session management
chatbotRouter.get("/sessions", handleGetSessions);
chatbotRouter.get("/sessions/:id", handleGetSession);
chatbotRouter.delete("/sessions/:id", handleDeleteSession);

export { chatbotRouter };
