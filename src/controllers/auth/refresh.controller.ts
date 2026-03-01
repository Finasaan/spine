import type { AppContext } from "../../types";

const COOKIE_NAME = "sb-token";
const REFRESH_COOKIE_NAME = "sb-refresh-token";
const COOKIE_OPTIONS = "HttpOnly; Path=/; SameSite=Lax; Max-Age=604800"; // 7 days
const COOKIE_CLEAR = `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
const REFRESH_COOKIE_CLEAR = `${REFRESH_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;

/**
 * POST /api/auth/refresh
 *
 * Exchanges a refresh_token (from the sb-refresh-token HttpOnly cookie) for a
 * new access_token + refresh_token pair, then rotates both cookies.
 *
 * This endpoint is intentionally unauthenticated (no authMiddleware) because
 * it is called when the access_token has already expired.
 *
 * On success: rotates both cookies, returns { success: true }.
 * On failure: clears both cookies, returns 401.
 */
export async function refresh(c: AppContext) {
    const cookieHeader = c.req.header("Cookie") ?? "";

    // Extract refresh token from the HttpOnly cookie
    const refreshToken = parseCookie(cookieHeader, REFRESH_COOKIE_NAME);

    if (!refreshToken) {
        return c.json({ success: false, error: "No refresh token" }, 401);
    }

    const supabaseUrl = c.env.SUPABASE_URL ?? "";
    const supabaseKey = c.env.SUPABASE_KEY ?? "";

    // Call GoTrue's token endpoint directly — the supabase-js client can't be
    // used here because it has autoRefreshToken:false and no persisted session.
    const tokenRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "apikey": supabaseKey,
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!tokenRes.ok) {
        // Refresh token is invalid or expired — force re-login
        c.header("Set-Cookie", COOKIE_CLEAR);
        c.header("Set-Cookie", REFRESH_COOKIE_CLEAR, { append: true });
        return c.json({ success: false, error: "Session expired, please sign in again" }, 401);
    }

    const session = await tokenRes.json() as {
        access_token: string;
        refresh_token: string;
    };

    const secure = c.req.url.startsWith("https") ? "; Secure" : "";

    // Rotate both cookies with fresh tokens
    c.header("Set-Cookie", `${COOKIE_NAME}=${session.access_token}${secure}; ${COOKIE_OPTIONS}`);
    c.header("Set-Cookie", `${REFRESH_COOKIE_NAME}=${session.refresh_token}${secure}; ${COOKIE_OPTIONS}`, { append: true });

    return c.json({ success: true });
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function parseCookie(cookieHeader: string, name: string): string | undefined {
    for (const part of cookieHeader.split(";")) {
        const [k, ...v] = part.trim().split("=");
        if (k.trim() === name) return v.join("=").trim();
    }
    return undefined;
}
