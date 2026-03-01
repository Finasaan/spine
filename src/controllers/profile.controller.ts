import { getSupabaseAdminClient } from "../db";
import type { AppContext } from "../types";

/**
 * Profile Controller
 * Handles user profile CRUD operations.
 */
export const profileController = {
    /**
     * PUT /profile
     * Creates or updates the authenticated user's profile.
     */
    upsertProfile: async (c: AppContext) => {
        const user = c.get("user");

        try {
            const body = await c.req.json();
            const { display_name, financial_knowledge, occupation, interests } = body;

            const supabase = await getSupabaseAdminClient(c.env);

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
                    { onConflict: "id" }
                )
                .select()
                .single();

            if (error) {
                console.error("Profile upsert error:", error);
                return c.json(
                    { success: false, error: "Failed to save profile", details: error.message },
                    500
                );
            }

            return c.json({ success: true, data });
        } catch (err) {
            console.error("Profile update error:", err);
            return c.json({ success: false, error: "Invalid request body" }, 400);
        }
    },

    /**
     * GET /profile
     * Returns the authenticated user's profile.
     */
    getProfile: async (c: AppContext) => {
        const user = c.get("user");

        try {
            const supabase = await getSupabaseAdminClient(c.env);

            const { data, error } = await supabase
                .from("user_profiles")
                .select("*")
                .eq("id", user.id)
                .single();

            if (error && error.code !== "PGRST116") {
                // PGRST116 = no rows — acceptable, user just hasn't set a profile yet
                console.error("Profile fetch error:", error);
                return c.json({ success: false, error: "Failed to fetch profile" }, 500);
            }

            return c.json({ success: true, data: data ?? null });
        } catch (err) {
            console.error("Profile fetch error:", err);
            return c.json({ success: false, error: "Internal server error" }, 500);
        }
    },
};
