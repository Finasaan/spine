import { createClient } from "@supabase/supabase-js";

/**
 * Helper to get secret value from Secrets Store binding or direct env var
 * Secrets Store bindings are Fetcher objects that need .get() method
 */
async function getSecretValue(value: any): Promise<string | null> {
  if (!value) return null;

  // If it's a string, return it directly (dev environment or plain env vars)
  if (typeof value === "string") {
    return value;
  }

  // If it's a Secrets Store binding (has get method), fetch the secret
  if (value && typeof value.get === "function") {
    try {
      const secretValue = await value.get();
      return secretValue ? String(secretValue) : null;
    } catch (error) {
      console.error("Error fetching secret from Secrets Store:", error);
      return null;
    }
  }

  return null;
}

/**
 * Resolves the Supabase URL + anon key for the current environment, handling
 * both plain string env vars (dev) and Secrets Store Fetcher bindings (prod/preview).
 *
 * Exported for direct use by routes that talk to GoTrue over raw fetch
 * (OAuth PKCE flow, refresh token rotation) and can't go through supabase-js.
 */
export async function getSupabaseAuthCredentials(env: any): Promise<{
  url: string;
  anonKey: string;
}> {
  const config = await getSupabaseConfig(env);
  return { url: config.url, anonKey: config.key };
}

/**
 * Environment-aware Supabase configuration
 * Determines which environment variables to use based on the deployment context
 */
async function getSupabaseConfig(env: any): Promise<{
  url: string;
  key: string;
}> {
  // Try development environment first (plain strings)
  const devUrl = await getSecretValue(env.SUPABASE_URL);
  const devKey = await getSecretValue(env.SUPABASE_KEY);
  if (devUrl && devKey) {
    console.log("Using development Supabase credentials from env vars");
    return { url: devUrl, key: devKey };
  }

  // Check for production secrets (Secrets Store bindings)
  const prodUrl = await getSecretValue(env.SUPABASE_URL_PRODUCTION);
  const prodKey = await getSecretValue(env.SUPABASE_ANON_KEY_PRODUCTION);
  if (prodUrl && prodKey) {
    console.log("Using production Supabase credentials from Secrets Store");
    return { url: prodUrl, key: prodKey };
  }

  // Check for preview secrets (Secrets Store bindings)
  const previewUrl = await getSecretValue(env.SUPABASE_URL_PREVIEW);
  const previewKey = await getSecretValue(env.SUPABASE_ANON_KEY_PREVIEW);
  if (previewUrl && previewKey) {
    console.log("Using preview Supabase credentials from Secrets Store");
    return { url: previewUrl, key: previewKey };
  }

  throw new Error(
    "Supabase configuration not found. Please set environment variables: SUPABASE_URL_PRODUCTION/SUPABASE_ANON_KEY_PRODUCTION (prod) or SUPABASE_URL_PREVIEW/SUPABASE_ANON_KEY_PREVIEW (preview) or SUPABASE_URL/SUPABASE_KEY (dev)"
  );
}

/**
 * Creates a Supabase client from Cloudflare Worker environment bindings
 * Automatically selects the correct credentials based on the deployment environment:
 * - Production: Uses SUPABASE_URL_PRODUCTION and SUPABASE_ANON_KEY_PRODUCTION from Secrets Store
 * - Preview: Uses SUPABASE_URL_PREVIEW and SUPABASE_ANON_KEY_PREVIEW from Secrets Store
 * - Development: Uses SUPABASE_URL and SUPABASE_KEY from .dev.vars
 *
 * Note: When using secrets_store_secrets in wrangler.jsonc, the bindings are Fetcher objects
 * that require calling .get() to retrieve the actual secret values.
 */
export async function getSupabaseClient(env: {
  SUPABASE_URL?: string | any;
  SUPABASE_KEY?: string | any;
  SUPABASE_URL_PRODUCTION?: string | any;
  SUPABASE_ANON_KEY_PRODUCTION?: string | any;
  SUPABASE_URL_PREVIEW?: string | any;
  SUPABASE_ANON_KEY_PREVIEW?: string | any;
}) {
  const config = await getSupabaseConfig(env);
  console.log("Using Supabase URL:", config.url);
  return createClient(config.url, config.key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Gets Supabase admin configuration with service role key
 * Used for server-side JWT validation and admin operations
 */
async function getSupabaseAdminConfig(env: any): Promise<{
  url: string;
  serviceRoleKey: string;
}> {
  // Try development environment first
  const devUrl = await getSecretValue(env.SUPABASE_URL);
  const devServiceKey = await getSecretValue(env.SUPABASE_SERVICE_ROLE_KEY);
  if (devUrl && devServiceKey) {
    return { url: devUrl, serviceRoleKey: devServiceKey };
  }

  // Check for production secrets
  const prodUrl = await getSecretValue(env.SUPABASE_URL_PRODUCTION);
  const prodServiceKey = await getSecretValue(
    env.SUPABASE_SERVICE_ROLE_KEY_PRODUCTION
  );
  if (prodUrl && prodServiceKey) {
    return { url: prodUrl, serviceRoleKey: prodServiceKey };
  }

  // Check for preview secrets
  const previewUrl = await getSecretValue(env.SUPABASE_URL_PREVIEW);
  const previewServiceKey = await getSecretValue(
    env.SUPABASE_SERVICE_ROLE_KEY_PREVIEW
  );
  if (previewUrl && previewServiceKey) {
    return { url: previewUrl, serviceRoleKey: previewServiceKey };
  }

  throw new Error(
    "Supabase admin configuration not found. Please set SUPABASE_SERVICE_ROLE_KEY environment variable."
  );
}

/**
 * Creates a Supabase admin client with service role key
 * Use this for server-side JWT validation and admin operations
 * WARNING: This bypasses RLS - never expose to clients
 */
export async function getSupabaseAdminClient(env: {
  SUPABASE_URL?: string | any;
  SUPABASE_SERVICE_ROLE_KEY?: string | any;
  SUPABASE_URL_PRODUCTION?: string | any;
  SUPABASE_SERVICE_ROLE_KEY_PRODUCTION?: string | any;
  SUPABASE_URL_PREVIEW?: string | any;
  SUPABASE_SERVICE_ROLE_KEY_PREVIEW?: string | any;
}) {
  const config = await getSupabaseAdminConfig(env);
  return createClient(config.url, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
