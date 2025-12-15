import { createMiddleware } from "hono/factory";
import { getSupabaseAdminClient } from "../db";
import type { User } from "@supabase/supabase-js";

// Extend the context to include the authenticated user
declare module "hono" {
  interface ContextVariableMap {
    user: User;
  }
}

/**
 * Auth middleware - validates JWT token from Authorization header
 * Uses Supabase service role key to verify the token server-side
 * Attaches the user to the context for downstream handlers
 */
export const authMiddleware = createMiddleware<{
  Bindings: CloudflareBindings;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(
      {
        success: false,
        error: "Unauthorized - Missing or invalid authorization header",
      },
      401
    );
  }

  const token = authHeader.substring(7); // Remove "Bearer " prefix

  if (!token) {
    return c.json(
      {
        success: false,
        error: "Unauthorized - Invalid token",
      },
      401
    );
  }

  try {
    // Create admin client with service role key for JWT validation
    const supabase = await getSupabaseAdminClient(c.env);

    // Validate the JWT and get user data
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      console.error("Token validation error:", error?.message);
      return c.json(
        {
          success: false,
          error: "Unauthorized - Invalid or expired token",
        },
        401
      );
    }

    // Attach user to context for downstream handlers
    c.set("user", user);

    await next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    return c.json(
      {
        success: false,
        error: "Internal server error during authentication",
      },
      500
    );
  }
});

/**
 * Optional auth middleware - doesn't fail if no token, just continues
 * Attaches user to context if token is valid, otherwise continues without user
 */
export const optionalAuthMiddleware = createMiddleware<{
  Bindings: CloudflareBindings;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);

    if (token) {
      try {
        const supabase = await getSupabaseAdminClient(c.env);
        const {
          data: { user },
        } = await supabase.auth.getUser(token);

        if (user) {
          c.set("user", user);
        }
      } catch (error) {
        // Silently continue without user
        console.warn("Optional auth failed:", error);
      }
    }
  }

  await next();
});
