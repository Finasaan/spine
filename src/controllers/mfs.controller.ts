import { getSupabaseClient } from "../db";
import { AppContext, errorResponse, paginatedResponse } from "../types";

/**
 * MFS Controller - Handles Mutual Funds related endpoints
 */
export const mfsController = {
  /**
   * Get list of mutual funds with optional search
   * Query params: limit, offset, search
   */
  getMutualFunds: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const limit = parseInt(c.req.query("limit") || "20");
      const offset = parseInt(c.req.query("offset") || "0");
      const search = c.req.query("search") || "";

      // Build base query - select fields needed for listing
      let query = supabase
        .from("mutual_funds")
        .select("id, symbol, name, aum, ytd, risk_profile", { count: "exact" });

      // Add search filter if provided
      if (search.trim()) {
        query = query.or(
          `symbol.ilike.%${search}%,name.ilike.%${search}%`
        );
      }

      // Order by name and apply pagination
      query = query.order("name", { ascending: true });
      query = query.range(offset, offset + limit - 1);

      const { data, error, count } = await query;

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      return c.json(paginatedResponse(data, { limit, offset, total: count }));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get a single mutual fund by ID
   */
  getMutualFundById: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const id = c.req.param("id");

      const { data, error } = await supabase
        .from("mutual_funds")
        .select("*")
        .eq("id", id)
        .single();

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      if (!data) {
        return c.json({ success: false, error: "Mutual fund not found" }, 404);
      }

      return c.json({
        success: true,
        data,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get mutual fund by symbol
   */
  getMutualFundBySymbol: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const symbol = c.req.param("symbol");

      const { data, error } = await supabase
        .from("mutual_funds")
        .select("*")
        .eq("symbol", symbol.toUpperCase())
        .single();

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      if (!data) {
        return c.json({ success: false, error: "Mutual fund not found" }, 404);
      }

      return c.json({
        success: true,
        data,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get NAV history for a mutual fund
   */
  getNavHistory: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const fundId = c.req.param("fundId");
      const limit = parseInt(c.req.query("limit") || "30");
      const offset = parseInt(c.req.query("offset") || "0");

      const { data, error, count } = await supabase
        .from("mutual_fund_nav_history")
        .select("*", { count: "exact" })
        .eq("fund_id", fundId)
        .order("nav_date", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      return c.json(paginatedResponse(data, { limit, offset, total: count }));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get fund providers
   */
  getFundProviders: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);

      const { data, error } = await supabase.from("fund_providers").select("*");

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      return c.json({
        success: true,
        data,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get top 10 mutual funds for dashboard display
   */
  getTopFunds: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);

      const { data, error } = await supabase
        .from("mutual_funds")
        .select(`
          id,
          symbol,
          name,
          aum,
          ytd,
          risk_profile
        `)
        .not("ytd", "is", null)
        .order("ytd", { ascending: false })
        .limit(10);

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      return c.json({
        success: true,
        data: data || [],
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },
};
