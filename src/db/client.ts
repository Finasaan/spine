import { createClient } from "@supabase/supabase-js";

/**
 * Environment-aware Supabase configuration
 * Determines which secret store binding to use based on the deployment environment
 */
function getSupabaseConfig(env: any): {
  url: string;
  key: string;
} {
  // Fallback to environment variables (for development/local use)
  if (env.SUPABASE_URL && env.SUPABASE_KEY) {
    console.log("Using development Supabase credentials.");
    return {
      url: env.SUPABASE_URL,
      key: env.SUPABASE_KEY,
    };
  }

  // Check for production secrets
  if (env.SUPABASE_URL_PRODUCTION && env.SUPABASE_ANON_KEY_PRODUCTION) {
    // console.log(ENVIRONMENT);
    console.log("Using production Supabase credentials.");
    return {
      url: env.SUPABASE_URL_PRODUCTION,
      key: env.SUPABASE_ANON_KEY_PRODUCTION,
    };
  }

  // Check for preview secrets
  if (env.SUPABASE_URL_PREVIEW && env.SUPABASE_ANON_KEY_PREVIEW) {
    console.log("Using preview Supabase credentials.");
    return {
      url: env.SUPABASE_URL_PREVIEW,
      key: env.SUPABASE_ANON_KEY_PREVIEW,
    };
  }

  throw new Error(
    "Supabase configuration not found. Please set SUPABASE_URL and SUPABASE_KEY or configure secret store bindings."
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
  SUPABASE_URL_PRODUCTION?: any;
  SUPABASE_ANON_KEY_PRODUCTION?: any;
  SUPABASE_URL_PREVIEW?: any;
  SUPABASE_ANON_KEY_PREVIEW?: any;
}) {
  const config = getSupabaseConfig(env);
  console.log("Using Supabase URL:", config.url);
  console.log("All available env keys:", Object.keys(env));
  return createClient(config.url, config.key);
}
