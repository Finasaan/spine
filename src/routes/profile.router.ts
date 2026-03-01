import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.middleware";
import { profileController } from "../controllers/profile.controller";

/**
 * Profile Router
 * Base path: /api/profile
 */
const profileRouter = new Hono<{ Bindings: CloudflareBindings }>();

profileRouter.get("/", authMiddleware, profileController.getProfile);
profileRouter.put("/", authMiddleware, profileController.upsertProfile);

export { profileRouter };
