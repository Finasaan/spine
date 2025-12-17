/**
 * Chatbot Router
 * Public routes for chatbot functionality (no auth required)
 */

import { Hono } from "hono";
import {
  handleChat,
  handleIngestDocuments,
  handleUploadPDF,
  handleGetChats,
  handleGetChat,
  handleDeleteChat,
  handleGetModels,
} from "../controllers/chatbot.controller";

const chatbotRouter = new Hono<{ Bindings: CloudflareBindings }>();

// ============================================
// Chat Routes
// ============================================

// Send chat message and get AI response with RAG
chatbotRouter.post("/chat", handleChat);

// Get available models
chatbotRouter.get("/models", handleGetModels);

// ============================================
// Document Routes
// ============================================

// Upload PDF document for RAG (multipart/form-data)
chatbotRouter.post("/documents/upload", handleUploadPDF);

// Ingest document chunks for RAG (JSON)
chatbotRouter.post("/documents", handleIngestDocuments);

// ============================================
// Chat Session Routes
// ============================================

// Get all chat sessions
chatbotRouter.get("/chats", handleGetChats);

// Get a specific chat session with messages
chatbotRouter.get("/chats/:id", handleGetChat);

// Delete a chat session
chatbotRouter.delete("/chats/:id", handleDeleteChat);

export { chatbotRouter };
