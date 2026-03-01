import { getSupabaseClient } from "../../db";
import type { AppContext } from "../../types";

const COOKIE_NAME = "sb-token";
const COOKIE_OPTIONS = "HttpOnly; Path=/; SameSite=Lax; Max-Age=604800"; // 7 days

/**
 * GET /auth/oauth/google
 * Generates a Google OAuth authorization URL server-side and redirects the user.
 * The browser is sent to Google; Google redirects back to the configured callback URL.
 */
export async function oauthGoogleRedirect(c: AppContext) {
    const supabase = await getSupabaseClient(c.env);

    // The redirect URL is core's /auth/callback, which will proxy back to us
    const redirectTo = c.req.query("redirectTo") ?? "";

    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
            redirectTo,
            skipBrowserRedirect: true, // We handle the redirect ourselves
        },
    });

    if (error || !data.url) {
        console.error("OAuth URL generation error:", error?.message);
        return c.json({ success: false, error: "Failed to initiate OAuth flow" }, 500);
    }

    return c.redirect(data.url);
}

/**
 * GET /auth/oauth/callback
 * Receives the authorization code from core (which proxied it from Google/Supabase).
 * Exchanges it for a session, sets the HttpOnly cookie, and redirects to the app.
 */
export async function oauthCallback(c: AppContext) {
    const code = c.req.query("code");
    const next = c.req.query("next") ?? "/onboarding";

    if (!code) {
        return c.redirect("/login?error=auth_failed");
    }

    const supabase = await getSupabaseClient(c.env);

    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error || !data.session) {
        console.error("OAuth code exchange error:", error?.message);
        return c.redirect("/login?error=auth_failed");
    }

    const { session } = data;

    const secure = c.req.url.startsWith("https") ? "; Secure" : "";
    c.header(
        "Set-Cookie",
        `${COOKIE_NAME}=${session.access_token}${secure}; ${COOKIE_OPTIONS}`
    );

    // Redirect the browser back to core
    const origin = c.req.header("Origin") ?? "";
    return c.redirect(`${origin}${next}`);
}
