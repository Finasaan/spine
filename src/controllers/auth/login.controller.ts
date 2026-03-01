import { getSupabaseClient } from "../../db";
import type { AppContext } from "../../types";

const COOKIE_NAME = "sb-token";
const REFRESH_COOKIE_NAME = "sb-refresh-token";
const COOKIE_OPTIONS = "HttpOnly; Path=/; SameSite=Lax; Max-Age=604800"; // 7 days

/**
 * POST /auth/login
 * Authenticates a user with email and password.
 * Sets HttpOnly session cookies (access + refresh) on success.
 */
export async function login(c: AppContext) {
    const body = await c.req.json<{ email: string; password: string }>();
    const { email, password } = body;

    if (!email || !password) {
        return c.json({ success: false, error: "Email and password are required" }, 400);
    }

    const supabase = await getSupabaseClient(c.env);

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.session) {
        return c.json({ success: false, error: error?.message ?? "Invalid credentials" }, 401);
    }

    const { session, user } = data;

    const secure = c.req.url.startsWith("https") ? "; Secure" : "";
    c.header(
        "Set-Cookie",
        `${COOKIE_NAME}=${session.access_token}${secure}; ${COOKIE_OPTIONS}`
    );
    c.header(
        "Set-Cookie",
        `${REFRESH_COOKIE_NAME}=${session.refresh_token}${secure}; ${COOKIE_OPTIONS}`,
        { append: true }
    );

    return c.json({
        success: true,
        data: {
            id: user.id,
            email: user.email,
            email_confirmed_at: user.email_confirmed_at,
            created_at: user.created_at,
            user_metadata: user.user_metadata,
        },
    });
}
