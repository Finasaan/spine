import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.middleware";
import { getSupabaseAdminClient } from "../db";

/**
 * Auth router - authentication endpoints
 */
export const authRouter = new Hono<{ Bindings: CloudflareBindings }>();

/**
 * GET /auth/me - Get current authenticated user
 * Requires valid JWT token in Authorization header
 */
authRouter.get("/me", authMiddleware, async (c) => {
    const user = c.get("user");

    return c.json({
        success: true,
        data: {
            id: user.id,
            email: user.email,
            email_confirmed_at: user.email_confirmed_at,
            created_at: user.created_at,
            updated_at: user.updated_at,
            user_metadata: user.user_metadata,
        },
    });
});

/**
 * POST /auth/logout - Sign out (invalidate session)
 * Note: This is optional as Supabase handles session on client-side
 * This endpoint can be used to invalidate all sessions server-side
 */
authRouter.post("/logout", authMiddleware, async (c) => {
    try {
        const user = c.get("user");
        const supabase = await getSupabaseAdminClient(c.env);

        // Sign out the user (invalidates all sessions for this user)
        const { error } = await supabase.auth.admin.signOut(user.id);

        if (error) {
            console.error("Logout error:", error.message);
            return c.json(
                {
                    success: false,
                    error: "Failed to sign out",
                },
                500
            );
        }

        return c.json({
            success: true,
            message: "Successfully signed out",
        });
    } catch (error) {
        console.error("Logout error:", error);
        return c.json(
            {
                success: false,
                error: "Internal server error",
            },
            500
        );
    }
});
