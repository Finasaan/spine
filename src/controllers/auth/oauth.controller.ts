import type { AppContext } from "../../types";
import { getSupabaseAdminClient } from "../../db";

const COOKIE_NAME = "sb-token";
const REFRESH_COOKIE_NAME = "sb-refresh-token";
const PKCE_COOKIE_NAME = "sb-pkce-verifier";
const COOKIE_OPTIONS = "HttpOnly; Path=/; SameSite=Lax; Max-Age=604800"; // 7 days
const PKCE_COOKIE_OPTIONS = "HttpOnly; Path=/; SameSite=Lax; Max-Age=300"; // 5 minutes

// ---------------------------------------------------------------------------
// PKCE helpers (Web Crypto — available in Cloudflare Workers)
// ---------------------------------------------------------------------------

/** Generate a cryptographically random code_verifier (43–128 chars, base64url). */
async function generateCodeVerifier(): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    return base64url(bytes);
}

/** Derive the code_challenge from a code_verifier: base64url(SHA-256(verifier)). */
async function generateCodeChallenge(verifier: string): Promise<string> {
    const encoded = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    return base64url(new Uint8Array(digest));
}

/** Encode a Uint8Array as a URL-safe base64 string (no padding). */
function base64url(bytes: Uint8Array): string {
    let str = "";
    for (const b of bytes) str += String.fromCharCode(b);
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/auth/oauth/google
 *
 * 1. Generates a PKCE code_verifier + code_challenge.
 * 2. Stores the verifier in a short-lived HttpOnly cookie (sb-pkce-verifier).
 * 3. Redirects the browser to Supabase's /auth/v1/authorize with the challenge.
 *
 * Supabase (GoTrue) then redirects the user to Google, and after authentication
 * redirects the browser to core's /auth/callback with ?code=<GoTrue_UUID>.
 */
export async function oauthGoogleRedirect(c: AppContext) {
    const supabaseUrl = c.env.SUPABASE_URL ?? "";
    const redirectTo = c.req.query("redirectTo") ?? "";

    const codeVerifier = await generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Store the verifier in a short-lived HttpOnly cookie — it will be read
    // back by oauthCallback after Google redirects through core.
    const secure = c.req.url.startsWith("https") ? "; Secure" : "";
    c.header("Set-Cookie", `${PKCE_COOKIE_NAME}=${codeVerifier}${secure}; ${PKCE_COOKIE_OPTIONS}`);

    const authorizeUrl = new URL(`${supabaseUrl}/auth/v1/authorize`);
    authorizeUrl.searchParams.set("provider", "google");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "s256");
    if (redirectTo) {
        authorizeUrl.searchParams.set("redirect_to", redirectTo);
    }

    return c.redirect(authorizeUrl.toString());
}

/**
 * GET /api/auth/oauth/callback
 *
 * Called by core's /auth/callback after Google → GoTrue sets ?code=<GoTrue_UUID>.
 *
 * 1. Reads the PKCE code_verifier from the sb-pkce-verifier HttpOnly cookie.
 * 2. POSTs to GoTrue /auth/v1/token?grant_type=pkce with the code + verifier.
 * 3. Sets sb-token (access_token) and sb-refresh-token (refresh_token) cookies.
 * 4. Clears the sb-pkce-verifier cookie.
 * 5. Checks if the user already has a profile — redirects to /dashboard if so,
 *    /onboarding if this is their first login.
 */
export async function oauthCallback(c: AppContext) {
    const code = c.req.query("code");
    // We determine the real next destination ourselves — ignore any passed `next`
    // to prevent the hardcoded /onboarding from always winning.
    const origin = c.req.query("origin") ?? "";

    if (!code) {
        console.error("OAuth callback: no code param");
        return c.redirect(`${origin}/login?error=auth_failed`);
    }

    // Read the PKCE verifier that was set during oauthGoogleRedirect.
    const cookieHeader = c.req.header("Cookie") ?? "";
    const codeVerifier = parseCookie(cookieHeader, PKCE_COOKIE_NAME);

    if (!codeVerifier) {
        console.error("OAuth callback: missing PKCE verifier cookie");
        return c.redirect(`${origin}/login?error=auth_failed`);
    }

    const supabaseUrl = c.env.SUPABASE_URL ?? "";
    const supabaseKey = c.env.SUPABASE_KEY ?? "";

    // Exchange the GoTrue auth code + verifier for tokens.
    const tokenRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=pkce`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "apikey": supabaseKey,
        },
        body: JSON.stringify({
            auth_code: code,
            code_verifier: codeVerifier,
        }),
    });

    if (!tokenRes.ok) {
        const err = await tokenRes.text();
        console.error("OAuth code exchange error:", err);
        return c.redirect(`${origin}/login?error=auth_failed`);
    }

    const session = await tokenRes.json() as {
        access_token: string;
        refresh_token: string;
        user: { id: string };
    };

    const secure = c.req.url.startsWith("https") ? "; Secure" : "";

    // Set access token cookie
    c.header("Set-Cookie", `${COOKIE_NAME}=${session.access_token}${secure}; ${COOKIE_OPTIONS}`);
    // Set refresh token cookie (also HttpOnly, same 7-day lifetime)
    c.header("Set-Cookie", `${REFRESH_COOKIE_NAME}=${session.refresh_token}${secure}; ${COOKIE_OPTIONS}`, { append: true });
    // Clear PKCE verifier cookie
    c.header("Set-Cookie", `${PKCE_COOKIE_NAME}=; Path=/; Max-Age=0`, { append: true });

    // Determine redirect destination: /dashboard for returning users, /onboarding for new ones.
    let next = "/onboarding";
    try {
        const supabase = await getSupabaseAdminClient(c.env);
        const { data } = await supabase
            .from("user_profiles")
            .select("id")
            .eq("id", session.user.id)
            .maybeSingle();
        if (data) {
            next = "/dashboard";
        }
    } catch (err) {
        // If the profile check fails, default to onboarding (safe fallback)
        console.error("OAuth callback: profile check failed", err);
    }

    return c.redirect(`${origin}${next}`);
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
