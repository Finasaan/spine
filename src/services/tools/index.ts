/**
 * Tools barrel export — FinasaanGPT
 * Creates all tool sets and merges them for use in streamText.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { createKnowledgeTools } from "./knowledge.tools";
import { createMarketTools } from "./market.tools";
import { createFundsTools } from "./funds.tools";
import { createUserTools } from "./user.tools";

export type { } from "./knowledge.tools";

/**
 * Factory that creates all tools with injected dependencies.
 * Returns a merged tools object ready to pass to streamText().
 */
export function createAllTools(
  supabase: SupabaseClient,
  ai: Ai,
  userId: string,
  sessionId: string,
) {
  return {
    ...createKnowledgeTools(supabase, ai, sessionId),
    ...createMarketTools(supabase),
    ...createFundsTools(supabase),
    ...createUserTools(supabase, userId),
  };
}

export { createKnowledgeTools } from "./knowledge.tools";
export { createMarketTools } from "./market.tools";
export { createFundsTools } from "./funds.tools";
export { createUserTools } from "./user.tools";
