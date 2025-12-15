import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.middleware";
import { getSupabaseAdminClient } from "../db";

/**
 * Profile router - user profile management endpoints
 */
export const profileRouter = new Hono<{ Bindings: CloudflareBindings }>();

/**
 * PUT /profile - Upsert user profile
 * Creates or updates the user's profile in public.user_profiles
 * Requires authentication
 */
profileRouter.put("/", authMiddleware, async (c) => {
    const user = c.get("user");

    try {
        const body = await c.req.json();
        const { display_name, financial_knowledge, occupation, interests } = body;

        const supabase = await getSupabaseAdminClient(c.env);

        // Upsert profile - insert or update based on user ID
        const { data, error } = await supabase
            .from("user_profiles")
            .upsert(
                {
                    id: user.id,
                    display_name,
                    financial_knowledge,
                    occupation,
                    interests,
                    updated_at: new Date().toISOString(),
                },
                {
                    onConflict: "id",
                }
            )
            .select()
            .single();

        if (error) {
            console.error("Profile upsert error:", error);
            return c.json(
                {
                    success: false,
                    error: "Failed to save profile",
                    details: error.message,
                },
                500
            );
        }

        return c.json({
            success: true,
            data,
        });
    } catch (error) {
        console.error("Profile update error:", error);
        return c.json(
            {
                success: false,
                error: "Invalid request body",
            },
            400
        );
    }
});

/**
 * GET /profile - Get current user's profile
 * Requires authentication
 */
profileRouter.get("/", authMiddleware, async (c) => {
    const user = c.get("user");

    try {
        const supabase = await getSupabaseAdminClient(c.env);

        const { data, error } = await supabase
            .from("user_profiles")
            .select("*")
            .eq("id", user.id)
            .single();

        if (error && error.code !== "PGRST116") {
            // PGRST116 = no rows returned, which is okay
            console.error("Profile fetch error:", error);
            return c.json(
                {
                    success: false,
                    error: "Failed to fetch profile",
                },
                500
            );
        }

        return c.json({
            success: true,
            data: data || null,
        });
    } catch (error) {
        console.error("Profile fetch error:", error);
        return c.json(
            {
                success: false,
                error: "Internal server error",
            },
            500
        );
    }
});
