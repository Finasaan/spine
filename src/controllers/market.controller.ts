/**
 * Market Controller
 * Handles market summary API endpoints.
 *
 * Endpoints:
 *   GET  /market/summary  — Public. Returns latest market index data (KSE-100, KSE-30).
 *                           Reads from DB cache first; if not found, fetches from PSX PDF.
 *   POST /market/ingest   — Public. Force-fetches and caches market data for the current date.
 */

import { getSupabaseAdminClient } from "../db";
import { AppContext, successResponse, errorResponse } from "../types";
import {
  getMarketDate,
  getMarketStatus,
  fetchWithFallback,
  getCachedMarketData,
  getLatestCachedMarketData,
  upsertMarketData,
  type MarketSummaryResponse,
} from "../services/market.service";

export const marketController = {
  /**
   * GET /market/summary
   * Returns the latest market summary with KSE-100 and KSE-30 index data.
   *
   * Flow:
   * 1. Determine the expected market date (based on PKT time/day rules)
   * 2. Check DB cache for that date
   * 3. If cache miss, fetch from PSX PDF → parse → upsert → return
   * 4. If PSX PDF unavailable, fall back to latest cached data
   */
  getSummary: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseAdminClient(c.env);
      const expectedDate = getMarketDate();
      const marketStatus = getMarketStatus();

      // Step 1: Check DB cache for the expected date
      let cached = await getCachedMarketData(supabase, expectedDate);

      if (cached.kse100 || cached.kse30) {
        // Cache hit — return cached data
        const response: MarketSummaryResponse = {
          kse100: cached.kse100,
          kse30: cached.kse30,
          trade_date: expectedDate,
          market_status: marketStatus,
          is_stale: false,
        };
        return c.json(successResponse(response));
      }

      // Step 2: Cache miss — try to fetch from PSX PDF
      const fetched = await fetchWithFallback(expectedDate, 5);

      if (fetched && (fetched.kse100 || fetched.kse30)) {
        // Upsert both indices in parallel
        const upsertPromises: Promise<void>[] = [];

        if (fetched.kse100) {
          upsertPromises.push(
            upsertMarketData(supabase, fetched.kse100, fetched.rawText)
          );
        }
        if (fetched.kse30) {
          upsertPromises.push(
            upsertMarketData(supabase, fetched.kse30)
          );
        }

        // Don't let upsert failures block the response
        try {
          await Promise.all(upsertPromises);
        } catch (upsertErr) {
          console.error("Market data upsert failed (non-blocking):", upsertErr);
        }

        const isStale = fetched.actualDate !== expectedDate;

        const response: MarketSummaryResponse = {
          kse100: fetched.kse100,
          kse30: fetched.kse30,
          trade_date: fetched.actualDate,
          market_status: marketStatus,
          is_stale: isStale,
        };
        return c.json(successResponse(response));
      }

      // Step 3: PSX PDF also unavailable — fall back to latest cached data
      const latestCached = await getLatestCachedMarketData(supabase);

      if (latestCached.kse100 || latestCached.kse30) {
        const response: MarketSummaryResponse = {
          kse100: latestCached.kse100,
          kse30: latestCached.kse30,
          trade_date: latestCached.tradeDate || expectedDate,
          market_status: marketStatus,
          is_stale: true,
        };
        return c.json(successResponse(response));
      }

      // Step 4: No data available at all
      const response: MarketSummaryResponse = {
        kse100: null,
        kse30: null,
        trade_date: expectedDate,
        market_status: marketStatus,
        is_stale: true,
      };
      return c.json(successResponse(response));
    } catch (err) {
      console.error("Market summary error:", err);
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * POST /market/ingest
   * Force-fetch and cache market data for the current expected date.
   * Useful for manual triggering or cron jobs.
   *
   * Query params:
   *   date (optional) — Override the target date (YYYY-MM-DD format)
   */
  ingest: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseAdminClient(c.env);
      const targetDate = c.req.query("date") || getMarketDate();

      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        return c.json(
          { success: false, error: "Invalid date format. Use YYYY-MM-DD." },
          400
        );
      }

      const fetched = await fetchWithFallback(targetDate, 3);

      if (!fetched || (!fetched.kse100 && !fetched.kse30)) {
        return c.json(
          {
            success: false,
            error: `No PSX PDF data available for ${targetDate} or recent dates`,
          },
          404
        );
      }

      // Upsert both indices
      const results: string[] = [];

      if (fetched.kse100) {
        await upsertMarketData(supabase, fetched.kse100, fetched.rawText);
        results.push(
          `KSE100: ${fetched.kse100.current_close} (${fetched.kse100.net_change >= 0 ? "+" : ""}${fetched.kse100.net_change})`
        );
      }
      if (fetched.kse30) {
        await upsertMarketData(supabase, fetched.kse30);
        results.push(
          `KSE30: ${fetched.kse30.current_close} (${fetched.kse30.net_change >= 0 ? "+" : ""}${fetched.kse30.net_change})`
        );
      }

      return c.json(
        successResponse({
          message: "Market data ingested successfully",
          date: fetched.actualDate,
          results,
        })
      );
    } catch (err) {
      console.error("Market ingest error:", err);
      return c.json(errorResponse(err), 500);
    }
  },
};
