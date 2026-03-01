import { getSupabaseClient } from "../../db";
import type { AppContext } from "../../types";

/**
 * POST /auth/signup
 * Registers a new user with email and password.
 * Supabase sends a verification email; the user must confirm before logging in.
 */
export async function signup(c: AppContext) {
    const body = await c.req.json<{ email: string; password: string; emailRedirectTo?: string }>();
    const { email, password, emailRedirectTo } = body;

    if (!email || !password) {
        return c.json({ success: false, error: "Email and password are required" }, 400);
    }

    if (password.length < 6) {
        return c.json({ success: false, error: "Password must be at least 6 characters" }, 400);
    }

    const supabase = await getSupabaseClient(c.env);

    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            emailRedirectTo: emailRedirectTo ?? undefined,
        },
    });

    if (error) {
        return c.json({ success: false, error: error.message }, 400);
    }

    return c.json({
        success: true,
        data: {
            id: data.user?.id,
            email: data.user?.email,
            // confirmationSent is true when email confirmation is required
            confirmationSent: !data.session,
        },
    });
}
