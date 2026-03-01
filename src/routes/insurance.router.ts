/**
 * Insurance Router — Spine (embedding + retrieval side)
 * Public routes for insurance RAG (no auth required)
 */

import { Hono } from "hono";
import {
  handleInsuranceIngest,
  handleInsuranceSearch,
} from "../controllers/insurance.controller";

const insuranceRouter = new Hono<{ Bindings: CloudflareBindings }>();

// Receive preprocessed chunks from marrow, embed, and store
insuranceRouter.post("/ingest", handleInsuranceIngest);

// Search insurance chunks via vector similarity
insuranceRouter.post("/search", handleInsuranceSearch);

export { insuranceRouter };
