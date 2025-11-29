import { createClient } from "@supabase/supabase-js";

/**
 * Creates a Supabase client from Cloudflare Worker environment bindings
 * Based on: https://developers.cloudflare.com/workers/databases/third-party-integrations/supabase/
 */
export function getSupabaseClient(env: {
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
}) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
}
