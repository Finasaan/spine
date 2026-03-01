import { createMiddleware } from "hono/factory";
import { Context } from "hono";
import { getSupabaseAdminClient } from "../db";
import type { User } from "@supabase/supabase-js";

// Extend the context to include the authenticated user and their token
declare module "hono" {
  interface ContextVariableMap {
    user: User;
    token: string;
  }
}

/**
 * Extracts the bearer token from the request.
 * Checks the Authorization header first, then falls back to the sb-token HttpOnly cookie.
 */
function extractToken(c: Context): string | null {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.substring(7) || null;
  }

  const cookie = c.req.header("Cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)sb-token=([^;]+)/);
  return match?.[1] ?? null;
}

/**
 * Auth middleware - validates the JWT from the Authorization header or sb-token cookie.
 * Uses the Supabase service role key to verify the token server-side.
 * Attaches the validated user to the context for downstream handlers.
 */
export const authMiddleware = createMiddleware<{
  Bindings: CloudflareBindings;
}>(async (c, next) => {
  const token = extractToken(c);

  if (!token) {
    return c.json(
      { success: false, error: "Unauthorized - No valid token provided" },
      401
    );
  }

  try {
    const supabase = await getSupabaseAdminClient(c.env);

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      console.error("Token validation error:", error?.message);
      return c.json(
        { success: false, error: "Unauthorized - Invalid or expired token" },
        401
      );
    }

    c.set("user", user);
    c.set("token", token);
    await next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    return c.json(
      { success: false, error: "Internal server error during authentication" },
      500
    );
  }
});

/**
 * Optional auth middleware - does not reject the request if no token is present.
 * Attaches the user to context if a valid token is found; otherwise continues without one.
 */
export const optionalAuthMiddleware = createMiddleware<{
  Bindings: CloudflareBindings;
}>(async (c, next) => {
  const token = extractToken(c);

  if (token) {
    try {
      const supabase = await getSupabaseAdminClient(c.env);
      const {
        data: { user },
      } = await supabase.auth.getUser(token);

      if (user) {
        c.set("user", user);
      }
    } catch {
      // Silently continue without user
    }
  }

  await next();
});
