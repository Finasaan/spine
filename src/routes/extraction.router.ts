/**
 * Extraction Router
 * Routes for LLM-powered table structuring.
 * Called by marrow during ingestion to convert raw tables into structured JSON.
 */

import { Hono } from "hono";
import { handleStructureTable } from "../controllers/extraction.controller";

const extractionRouter = new Hono<{ Bindings: CloudflareBindings }>();

// Structure a raw table via LLM and store the result
extractionRouter.post("/structure-table", handleStructureTable);

export { extractionRouter };
