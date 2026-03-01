import { Hono } from "hono";
import { authMiddleware } from "../../middleware/auth.middleware";
import { login, signup, logout, me, oauthGoogleRedirect, oauthCallback } from "../../controllers/auth";

/**
 * Auth Router
 * Handles all authentication-related routes.
 * Base path: /api/auth
 */
const authRouter = new Hono<{ Bindings: CloudflareBindings }>();

// Email / password
authRouter.post("/login", login);
authRouter.post("/signup", signup);

// Session
authRouter.get("/me", authMiddleware, me);
authRouter.post("/logout", authMiddleware, logout);

// OAuth
authRouter.get("/oauth/google", oauthGoogleRedirect);
authRouter.get("/oauth/callback", oauthCallback);

export { authRouter };
