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
function extractToken(c: Context, name: string = "sb-token"): string | null {
  const authHeader = c.req.header("Authorization");
  if (name === "sb-token" && authHeader?.startsWith("Bearer ")) {
    return authHeader.substring(7) || null;
  }

  const cookie = c.req.header("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
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

    let {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    // If token is expired, attempt automatic refresh using refresh token cookie
    if (error?.message?.includes("expired") || error?.message?.includes("invalid claims")) {
      const refreshToken = extractToken(c, "sb-refresh-token");
      
      if (refreshToken) {
        const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession({
          refresh_token: refreshToken,
        });

        if (!refreshError && refreshData.session && refreshData.user) {
          const { session, user: refreshedUser } = refreshData;
          
          // Update tokens in context
          user = refreshedUser;
          
          // Set new cookies in the response
          const secure = c.req.url.startsWith("https") ? "; Secure" : "";
          const cookieOptions = "HttpOnly; Path=/; SameSite=Lax; Max-Age=604800"; // 7 days
          
          c.header("Set-Cookie", `sb-token=${session.access_token}${secure}; ${cookieOptions}`);
          c.header("Set-Cookie", `sb-refresh-token=${session.refresh_token}${secure}; ${cookieOptions}`, { append: true });
          
          c.set("user", user);
          c.set("token", session.access_token);
          return await next();
        }
      }
    }

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
