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
   * Get all sectors with performance data (daily change, top gainer/loser, volume).
   * This endpoint enriches sectors with price data from the latest trading day.
   */
  getSectorPerformance: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const BILLS_BONDS_SECTOR_ID = "978757d6-3c54-4704-bf4b-5f0e489ab668";

      // Get sectors
      const { data: sectors, error: sectorsError } = await supabase
        .from("sectors")
        .select("id, name, description, parent_sector_id")
        .neq("id", BILLS_BONDS_SECTOR_ID)
        .order("name", { ascending: true });

      if (sectorsError || !sectors) {
        return c.json({ success: false, error: sectorsError?.message || "Failed to fetch sectors" }, 500);
      }

      // Get latest trade date
      const { data: latestData } = await supabase
        .from("daily_stock_data")
        .select("trade_date")
        .order("trade_date", { ascending: false })
        .limit(1)
        .single();

      if (!latestData?.trade_date) {
        // Return sectors without performance data
        const result = sectors.map((s: { id: string; name: string; description: string | null; parent_sector_id: string | null }) => ({
          ...s,
          company_count: 0,
          avg_change_pct: null,
          total_volume: null,
          top_gainer: null,
          top_loser: null,
        }));
        return c.json(successResponse(result));
      }

      // Get all companies with their sector and latest price data in one query
      const { data: priceData, error: priceError } = await supabase
        .from("daily_stock_data")
        .select(`
          company_id,
          open_price,
          close_price,
          volume,
          value_traded,
          companies!inner (
            id,
            symbol,
            company_name,
            sector_id
          )
        `)
        .eq("trade_date", latestData.trade_date)
        .neq("companies.sector_id", BILLS_BONDS_SECTOR_ID);

      if (priceError) {
        return c.json({ success: false, error: priceError.message }, 500);
      }

      // Build sector performance data
      const sectorMap = new Map<string, {
        companies: number;
        totalChangePct: number;
        totalVolume: number;
        gainers: number;
        losers: number;
        topGainer: { symbol: string; company_name: string; change_pct: number } | null;
        topLoser: { symbol: string; company_name: string; change_pct: number } | null;
      }>();

      // Initialize all sectors
      for (const s of sectors) {
        sectorMap.set(s.id, {
          companies: 0,
          totalChangePct: 0,
          totalVolume: 0,
          gainers: 0,
          losers: 0,
          topGainer: null,
          topLoser: null,
        });
      }

      for (const row of priceData || []) {
        const company = row.companies as unknown as { id: string; symbol: string; company_name: string; sector_id: string };
        if (!company?.sector_id) continue;

        const entry = sectorMap.get(company.sector_id);
        if (!entry) continue;

        const changePct = row.open_price && row.open_price > 0
          ? ((row.close_price - row.open_price) / row.open_price) * 100
          : 0;

        entry.companies++;
        entry.totalChangePct += changePct;
        entry.totalVolume += row.volume || 0;

        if (changePct >= 0) entry.gainers++;
        else entry.losers++;

        if (!entry.topGainer || changePct > entry.topGainer.change_pct) {
          entry.topGainer = { symbol: company.symbol, company_name: company.company_name, change_pct: changePct };
        }
        if (!entry.topLoser || changePct < (entry.topLoser?.change_pct ?? 0)) {
          entry.topLoser = { symbol: company.symbol, company_name: company.company_name, change_pct: changePct };
        }
      }

      const result = sectors
        .map((s: { id: string; name: string; description: string | null; parent_sector_id: string | null }) => {
          const perf = sectorMap.get(s.id);
          return {
            ...s,
            company_count: perf?.companies || 0,
            avg_change_pct: perf && perf.companies > 0
              ? parseFloat((perf.totalChangePct / perf.companies).toFixed(2))
              : null,
            total_volume: perf?.totalVolume || 0,
            gainers: perf?.gainers || 0,
            losers: perf?.losers || 0,
            top_gainer: perf?.topGainer || null,
            top_loser: perf?.topLoser || null,
          };
        })
        .filter((s: { company_count: number }) => s.company_count > 0);

      return c.json(successResponse(result));
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
