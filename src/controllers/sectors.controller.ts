import { getSupabaseClient } from "../db";
import { AppContext, errorResponse, successResponse, paginatedResponse } from "../types";

/**
 * Sectors Controller - Handles sector-related endpoints
 */
export const sectorsController = {
  /**
   * Get all sectors with company counts.
   * Returns sectors sorted alphabetically with the number of companies in each.
   */
  getSectors: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);

      // Fetch sectors with company counts via Supabase aggregation
      const { data: sectors, error } = await supabase
        .from("sectors")
        .select("id, name, description, parent_sector_id")
        .order("name", { ascending: true });

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      if (!sectors || sectors.length === 0) {
        return c.json(successResponse([]));
      }

      // Fetch company counts per sector in one query
      const { data: countData, error: countError } = await supabase
        .from("companies")
        .select("sector_id");

      if (countError) {
        // Return sectors without counts as fallback
        const result = sectors.map((s: { id: string; name: string; description: string | null; parent_sector_id: string | null }) => ({
          ...s,
          company_count: 0,
        }));
        return c.json(successResponse(result));
      }

      // Count companies per sector
      const countMap = new Map<string, number>();
      for (const row of countData || []) {
        const sid = (row as { sector_id: string | null }).sector_id;
        if (sid) {
          countMap.set(sid, (countMap.get(sid) || 0) + 1);
        }
      }

      const result = sectors.map((s: { id: string; name: string; description: string | null; parent_sector_id: string | null }) => ({
        ...s,
        company_count: countMap.get(s.id) || 0,
      }));

      return c.json(successResponse(result));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get a sector by ID
   */
  getSectorById: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const id = c.req.param("id");

      const { data, error } = await supabase
        .from("sectors")
        .select("*")
        .eq("id", id)
        .single();

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      if (!data) {
        return c.json({ success: false, error: "Sector not found" }, 404);
      }

      return c.json(successResponse(data));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get companies in a sector with optional latest price data and pagination.
   * Query params: limit, offset, search, withPrice (default: false)
   */
  getSectorCompanies: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const sectorId = c.req.param("sectorId");
      const limit = parseInt(c.req.query("limit") || "50");
      const offset = parseInt(c.req.query("offset") || "0");
      const search = c.req.query("search") || "";
      const withPrice = c.req.query("withPrice") === "true";

      let query = supabase
        .from("companies")
        .select("id, symbol, company_name, sector_id", { count: "exact" })
        .eq("sector_id", sectorId);

      if (search.trim()) {
        query = query.or(
          `symbol.ilike.%${search}%,company_name.ilike.%${search}%`
        );
      }

      query = query.order("symbol", { ascending: true });
      query = query.range(offset, offset + limit - 1);

      const { data: companies, error, count } = await query;

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      let result = companies || [];

      // Enrich with latest price data if requested
      if (withPrice && companies && companies.length > 0) {
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
            .select("company_id, open_price, close_price, high_price, low_price, volume")
            .eq("trade_date", latestData.trade_date)
            .in("company_id", companyIds);

          const priceMap = new Map(
            priceData?.map(
              (p: {
                company_id: string;
                open_price: number;
                close_price: number;
                high_price: number;
                low_price: number;
                volume: number;
              }) => [
                p.company_id,
                {
                  open_price: p.open_price,
                  close_price: p.close_price,
                  high_price: p.high_price,
                  low_price: p.low_price,
                  volume: p.volume,
                },
              ]
            ) || []
          );

          result = companies.map(
            (company: {
              id: string;
              symbol: string;
              company_name: string;
              sector_id: string;
            }) => ({
              ...company,
              ...(priceMap.get(company.id) || {}),
            })
          );
        }
      }

      return c.json(paginatedResponse(result, { limit, offset, total: count }));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },
};
