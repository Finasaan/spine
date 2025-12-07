import { createClient } from "@supabase/supabase-js";

/**
 * Environment-aware Supabase configuration
 * Determines which environment variables to use based on the deployment context
 */
function getSupabaseConfig(env: any): {
  url: string;
  key: string;
} {
  if (env.SUPABASE_URL && env.SUPABASE_KEY) {
    const url = String(env.SUPABASE_URL);
    const key = String(env.SUPABASE_KEY);
    console.log("Using development Supabase credentials from env vars");
    return { url, key };
  }

  // Check for production secrets (standard environment variables)
  if (env.SUPABASE_URL_PRODUCTION && env.SUPABASE_ANON_KEY_PRODUCTION) {
    const url = String(env.SUPABASE_URL_PRODUCTION);
    const key = String(env.SUPABASE_ANON_KEY_PRODUCTION);
    console.log("Using production Supabase credentials from env vars");
    return { url, key };
  }

  // Check for preview secrets
  if (env.SUPABASE_URL_PREVIEW && env.SUPABASE_ANON_KEY_PREVIEW) {
    const url = String(env.SUPABASE_URL_PREVIEW);
    const key = String(env.SUPABASE_ANON_KEY_PREVIEW);
    console.log("Using preview Supabase credentials from env vars");
    return { url, key };
  }

  throw new Error(
    "Supabase configuration not found. Please set environment variables: SUPABASE_URL_PRODUCTION/SUPABASE_ANON_KEY_PRODUCTION (prod) or SUPABASE_URL_PREVIEW/SUPABASE_ANON_KEY_PREVIEW (preview) or SUPABASE_URL/SUPABASE_KEY (dev)"
  );
}

/**
 * Creates a Supabase client from Cloudflare Worker environment bindings
 * Automatically selects the correct credentials based on the deployment environment:
 * - Production: Uses SUPABASE_URL_PRODUCTION and SUPABASE_ANON_KEY_PRODUCTION
 * - Preview: Uses SUPABASE_URL_PREVIEW and SUPABASE_ANON_KEY_PREVIEW
 * - Development: Uses SUPABASE_URL and SUPABASE_KEY
 * Based on: https://developers.cloudflare.com/workers/databases/third-party-integrations/supabase/
 */
export function getSupabaseClient(env: {
  SUPABASE_URL?: string;
  SUPABASE_KEY?: string;
  SUPABASE_URL_PRODUCTION?: string;
  SUPABASE_ANON_KEY_PRODUCTION?: string;
  SUPABASE_URL_PREVIEW?: string;
  SUPABASE_ANON_KEY_PREVIEW?: string;
}) {
  const config = getSupabaseConfig(env);
  console.log("Using Supabase URL:", config.url);
  return createClient(config.url, config.key);
}
