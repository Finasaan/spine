import { getSupabaseAdminClient } from "../../db";
import type { AppContext } from "../../types";

const COOKIE_NAME = "sb-token";
const COOKIE_CLEAR = `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;

/**
 * POST /auth/logout
 * Always clears the session cookie, regardless of whether the token is valid.
 * Attempts to invalidate the session server-side if a token is present,
 * but does not require a valid session — handles stale/deleted-account tokens.
 */
export async function logout(c: AppContext) {
    // Extract token directly (no authMiddleware — we must handle stale tokens)
    const cookie = c.req.header("Cookie") ?? "";
    const match = cookie.match(/(?:^|;\s*)sb-token=([^;]+)/);
    const token = match?.[1] ?? null;

    // Best-effort server-side invalidation — ignore errors (token may be stale)
    if (token) {
        try {
            const supabase = await getSupabaseAdminClient(c.env);
            await supabase.auth.admin.signOut(token);
        } catch {
            // Silently ignore — the cookie will be cleared regardless
        }
    }

    // Always clear the cookie
    c.header("Set-Cookie", COOKIE_CLEAR);
    return c.json({ success: true, message: "Successfully signed out" });
}
