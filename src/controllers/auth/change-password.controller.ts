import { getSupabaseClient, getSupabaseAdminClient } from "../../db";
import type { AppContext } from "../../types";

/**
 * POST /auth/change-password
 * Authenticated. Re-verifies the current password before updating.
 * Re-auth uses signInWithPassword on the user's email — if it succeeds
 * the current password is correct. The actual update is done with the
 * admin client to avoid juggling session tokens.
 */
export async function changePassword(c: AppContext) {
    const user = c.get("user");

    if (!user.email) {
        return c.json({ success: false, error: "Account has no email on file" }, 400);
    }

    let body: { currentPassword?: string; newPassword?: string };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ success: false, error: "Invalid request body" }, 400);
    }

    const { currentPassword, newPassword } = body;

    if (!currentPassword || !newPassword) {
        return c.json(
            { success: false, error: "Current and new password are required" },
            400
        );
    }

    if (newPassword.length < 6) {
        return c.json(
            { success: false, error: "New password must be at least 6 characters" },
            400
        );
    }

    if (currentPassword === newPassword) {
        return c.json(
            { success: false, error: "New password must be different from current password" },
            400
        );
    }

    // Verify current password by attempting a sign-in
    const supabase = await getSupabaseClient(c.env);
    const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
    });

    if (signInError) {
        return c.json({ success: false, error: "Current password is incorrect" }, 400);
    }

    // Update via admin client (service role)
    const admin = await getSupabaseAdminClient(c.env);
    const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
        password: newPassword,
    });

    if (updateError) {
        console.error("Password update error:", updateError);
        return c.json({ success: false, error: "Failed to update password" }, 500);
    }

    return c.json({ success: true });
}
