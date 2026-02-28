import { getSupabaseClient } from "../db";
import { AppContext, errorResponse, paginatedResponse } from "../types";

/**
 * PSX Controller - Handles Pakistan Stock Exchange related endpoints
 */
export const psxController = {
  /**
   * Get list of companies with optional search and latest price data
   * Query params: limit, offset, search, withPrice (default: false)
   */
  getCompanies: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const limit = parseInt(c.req.query("limit") || "20");
      const offset = parseInt(c.req.query("offset") || "0");
      const search = c.req.query("search") || "";
      const withPrice = c.req.query("withPrice") === "true";

      // Bills & bonds sector to exclude
      const BILLS_BONDS_SECTOR_ID = "978757d6-3c54-4704-bf4b-5f0e489ab668";

      // Build base query
      let query = supabase
        .from("companies")
        .select("id, symbol, company_name, sector_id", { count: "exact" })
        .neq("sector_id", BILLS_BONDS_SECTOR_ID);

      // Add search filter if provided
      if (search.trim()) {
        query = query.or(
          `symbol.ilike.%${search}%,company_name.ilike.%${search}%`
        );
      }

      // Order by symbol and apply pagination
      query = query.order("symbol", { ascending: true });
      query = query.range(offset, offset + limit - 1);

      const { data: companies, error, count } = await query;

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      // If withPrice is requested, fetch latest prices for these companies
      let result = companies || [];

      if (withPrice && companies && companies.length > 0) {
        // Get the latest trade date
        const { data: latestData } = await supabase
          .from("daily_stock_data")
          .select("trade_date")
          .order("trade_date", { ascending: false })
          .limit(1)
          .single();

        if (latestData?.trade_date) {
          const companyIds = companies.map((c: { id: string }) => c.id);

          const { data: priceData } = await supabase
            .from("daily_stock_data")
            .select("company_id, open_price, close_price")
            .eq("trade_date", latestData.trade_date)
            .in("company_id", companyIds);

          // Merge price data with companies
          const priceMap = new Map(
            priceData?.map((p: { company_id: string; open_price: number; close_price: number }) => [
              p.company_id,
              { open_price: p.open_price, close_price: p.close_price }
            ]) || []
          );

          result = companies.map((company: { id: string; symbol: string; company_name: string; sector_id: string }) => ({
            ...company,
            ...(priceMap.get(company.id) || {}),
          }));
        }
      }

      return c.json(paginatedResponse(result, { limit, offset, total: count }));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get a single company by ID
   */
  getCompanyById: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const id = c.req.param("id");

      const { data, error } = await supabase
        .from("companies")
        .select("*")
        .eq("id", id)
        .single();

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      if (!data) {
        return c.json({ success: false, error: "Company not found" }, 404);
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
   * Get company by symbol
   */
  getCompanyBySymbol: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const symbol = c.req.param("symbol");

      const { data, error } = await supabase
        .from("companies")
        .select("*")
        .eq("symbol", symbol.toUpperCase())
        .single();

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      if (!data) {
        return c.json({ success: false, error: "Company not found" }, 404);
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
   * Get daily stock data for a company
   */
  getStockData: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const companyId = c.req.param("companyId");
      const limit = parseInt(c.req.query("limit") || "30");
      const offset = parseInt(c.req.query("offset") || "0");

      const { data, error, count } = await supabase
        .from("daily_stock_data")
        .select("*", { count: "exact" })
        .eq("company_id", companyId)
        .order("trade_date", { ascending: false })
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
   * Get top 10 stocks by value traded from the latest trade date
   * Used for dashboard display
   */
  getTopStocks: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);

      // First, get the latest trade date
      const { data: latestData, error: latestError } = await supabase
        .from("daily_stock_data")
        .select("trade_date")
        .order("trade_date", { ascending: false })
        .limit(1)
        .single();

      if (latestError || !latestData) {
        return c.json({
          success: true,
          data: [],
          timestamp: new Date().toISOString(),
        });
      }

      const latestDate = latestData.trade_date;

      // Get top 10 stocks by value_traded on the latest date
      // Exclude bills & bonds sector
      const BILLS_BONDS_SECTOR_ID = "978757d6-3c54-4704-bf4b-5f0e489ab668";

      const { data, error } = await supabase
        .from("daily_stock_data")
        .select(`
          id,
          trade_date,
          volume,
          value_traded,
          open_price,
          close_price,
          company_id,
          companies!inner (
            id,
            symbol,
            company_name,
            sector_id
          )
        `)
        .eq("trade_date", latestDate)
        .neq("companies.sector_id", BILLS_BONDS_SECTOR_ID)
        .order("value_traded", { ascending: false })
        .limit(10);

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      // Flatten the response
      const flatData = data?.map((item) => ({
        id: (item.companies as any)?.id,
        symbol: (item.companies as any)?.symbol,
        company_name: (item.companies as any)?.company_name,
        volume: item.volume,
        value_traded: item.value_traded,
        close_price: item.close_price,
        open_price: item.open_price,
        trade_date: item.trade_date,
      })) || [];

      return c.json({
        success: true,
        data: flatData,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },
};
