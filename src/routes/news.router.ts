import { Hono } from "hono";
import { handleGetNews, handleGetNewsItem, handleManualSync } from "../controllers/news.controller";

const newsRouter = new Hono<{ Bindings: CloudflareBindings }>();

// No auth middleware — news is public market data
newsRouter.get("/", handleGetNews);
newsRouter.get("/sync", handleManualSync);
newsRouter.get("/:id", handleGetNewsItem);


export { newsRouter };
