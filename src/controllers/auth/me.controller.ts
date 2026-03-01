import type { AppContext } from "../../types";

/**
 * GET /auth/me
 * Returns the currently authenticated user's public profile data.
 * Auth is validated upstream by authMiddleware; the user is already on context.
 */
export async function me(c: AppContext) {
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
}
