import { getSupabaseAdminClient } from "../../db";
import type { AppContext } from "../../types";

const COOKIE_NAME = "sb-token";
const COOKIE_CLEAR = `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;

/**
 * POST /auth/logout
 * Invalidates the user's session server-side and clears the session cookie.
 * Requires a valid session (via cookie or Authorization header).
 */
export async function logout(c: AppContext) {
    const token = c.get("token");

    try {
        const supabase = await getSupabaseAdminClient(c.env);

        const { error } = await supabase.auth.admin.signOut(token);

        if (error) {
            console.error("Logout error:", error.message);
            return c.json({ success: false, error: "Failed to sign out" }, 500);
        }

        c.header("Set-Cookie", COOKIE_CLEAR);

        return c.json({ success: true, message: "Successfully signed out" });
    } catch (err) {
        console.error("Logout error:", err);
        return c.json({ success: false, error: "Internal server error" }, 500);
    }
}
