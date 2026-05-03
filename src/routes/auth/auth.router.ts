import { Hono } from "hono";
import { authMiddleware } from "../../middleware/auth.middleware";
import {
    login,
    signup,
    logout,
    me,
    refresh,
    oauthGoogleRedirect,
    oauthCallback,
    changePassword,
    forgotPassword,
    resetPassword,
} from "../../controllers/auth";

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
authRouter.post("/logout", logout);

// Token refresh — no authMiddleware because the access token may be expired
authRouter.post("/refresh", refresh);

// Password management
authRouter.post("/change-password", authMiddleware, changePassword);
authRouter.post("/forgot-password", forgotPassword);
authRouter.post("/reset-password", resetPassword);

// OAuth
authRouter.get("/oauth/google", oauthGoogleRedirect);
authRouter.get("/oauth/callback", oauthCallback);

export { authRouter };
