import { getSupabaseAdminClient } from "../../db";
import type { AppContext } from "../../types";

/**
 * POST /auth/reset-password
 * Public. The client extracts the recovery access_token from the URL hash
 * (Supabase appends #access_token=...&type=recovery to the redirectTo URL)
 * and posts it here with the new password. We verify the token, then use
 * the admin client to set the password.
 */
export async function resetPassword(c: AppContext) {
    let body: { accessToken?: string; newPassword?: string };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ success: false, error: "Invalid request body" }, 400);
    }

    const { accessToken, newPassword } = body;

    if (!accessToken || !newPassword) {
        return c.json(
            { success: false, error: "Reset token and new password are required" },
            400
        );
    }

    if (newPassword.length < 6) {
        return c.json(
            { success: false, error: "Password must be at least 6 characters" },
            400
        );
    }

    const admin = await getSupabaseAdminClient(c.env);

    const { data: userData, error: tokenError } = await admin.auth.getUser(accessToken);

    if (tokenError || !userData.user) {
        return c.json(
            { success: false, error: "This reset link is invalid or has expired" },
            400
        );
    }

    const { error: updateError } = await admin.auth.admin.updateUserById(
        userData.user.id,
        { password: newPassword }
    );

    if (updateError) {
        console.error("Password reset update error:", updateError);
        return c.json({ success: false, error: "Failed to update password" }, 500);
    }

    return c.json({ success: true });
}
