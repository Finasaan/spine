import { getSupabaseClient } from "../../db";
import type { AppContext } from "../../types";

/**
 * POST /auth/forgot-password
 * Public. Sends a password-recovery email. Always responds with success
 * (even if the email isn't registered) to avoid leaking which addresses
 * exist on the platform. The client passes its own origin via redirectTo
 * so the recovery link lands on /update-password in the right environment.
 */
export async function forgotPassword(c: AppContext) {
    let body: { email?: string; redirectTo?: string };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ success: false, error: "Invalid request body" }, 400);
    }

    const { email, redirectTo } = body;

    if (!email) {
        return c.json({ success: false, error: "Email is required" }, 400);
    }

    const supabase = await getSupabaseClient(c.env);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: redirectTo || undefined,
    });

    if (error) {
        // Log but don't expose details to caller
        console.error("Reset email error:", error.message);
    }

    return c.json({ success: true });
}
