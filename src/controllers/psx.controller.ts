import { getSupabaseClient } from "../db";
import { AppContext, errorResponse, paginatedResponse } from "../types";

/**
 * PSX Controller - Handles Pakistan Stock Exchange related endpoints
 */
export const psxController = {
  /**
   * Get list of companies with optional search and latest price data
   * Query params: limit, offset, search, withPrice (default: false), sector (sector ID)
   */
  getCompanies: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const limit = parseInt(c.req.query("limit") || "20");
      const offset = parseInt(c.req.query("offset") || "0");
      const search = c.req.query("search") || "";
      const withPrice = c.req.query("withPrice") === "true";
      const sectorId = c.req.query("sector") || "";

      // Bills & bonds sector to exclude
      const BILLS_BONDS_SECTOR_ID = "978757d6-3c54-4704-bf4b-5f0e489ab668";

      // Build base query
      let query = supabase
        .from("companies")
        .select("id, symbol, company_name, sector_id", { count: "exact" })
        .neq("sector_id", BILLS_BONDS_SECTOR_ID);

      // Add sector filter if provided
      if (sectorId.trim()) {
        query = query.eq("sector_id", sectorId);
      }

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
   * Get company financials: extracted_tables, financial_reports + line_items, company_ratios.
   * Returns whatever data is available for the given company.
   */
  getCompanyFinancials: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const companyId = c.req.param("companyId");

      // First, get the company info (we need symbol/name for extracted_tables lookup)
      const { data: company, error: companyError } = await supabase
        .from("companies")
        .select("id, symbol, company_name")
        .eq("id", companyId)
        .single();

      if (companyError || !company) {
        return c.json({ success: false, error: "Company not found" }, 404);
      }

      // Parallel queries for all financial data sources
      const [extractedResult, reportsResult, ratiosResult] = await Promise.all([
        // 1. extracted_tables - match on company_id or company_name
        supabase
          .from("extracted_tables")
          .select(
            "id, company_name, company_id, table_name, table_type, fiscal_period, fiscal_period_end, currency, table_unit, comparative, headers, rows, source_type, created_at"
          )
          .or(`company_id.ilike.%${company.symbol}%,company_name.ilike.%${company.company_name}%`)
          .order("fiscal_period_end", { ascending: false, nullsFirst: false })
          .limit(20),

        // 2. financial_reports with their line items
        supabase
          .from("financial_reports")
          .select(`
            id, report_type, period_type, period_end_date, fiscal_year,
            fiscal_quarter, currency, source_url, filed_date,
            financial_report_line_items (
              id, item_key, item_label, item_value
            )
          `)
          .eq("company_id", companyId)
          .order("period_end_date", { ascending: false })
          .limit(12),

        // 3. company_ratios
        supabase
          .from("company_ratios")
          .select("id, as_of_date, ratio_key, ratio_value, ratio_period")
          .eq("company_id", companyId)
          .order("as_of_date", { ascending: false })
          .limit(50),
      ]);

      return c.json({
        success: true,
        data: {
          company: { id: company.id, symbol: company.symbol, company_name: company.company_name },
          extracted_tables: extractedResult.data || [],
          financial_reports: reportsResult.data || [],
          company_ratios: ratiosResult.data || [],
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get top 10 gainers (by intraday % change) from the latest trade date.
   * Restricts to actively traded stocks so illiquid micro-caps don't dominate.
   */
  getTopStocks: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);

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
      const BILLS_BONDS_SECTOR_ID = "978757d6-3c54-4704-bf4b-5f0e489ab668";

      // Pull the most-traded stocks first (liquidity floor), then re-rank by gain.
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
            sectors (
              name
            )
          )
        `)
        .eq("trade_date", latestDate)
        .neq("companies.sector_id", BILLS_BONDS_SECTOR_ID)
        .gt("open_price", 0)
        .order("value_traded", { ascending: false })
        .limit(50);

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      const ranked = (data || [])
        .map((item) => {
          const open = item.open_price ?? 0;
          const close = item.close_price ?? 0;
          const change_pct = open > 0 ? ((close - open) / open) * 100 : 0;
          return {
            id: (item.companies as any)?.id,
            symbol: (item.companies as any)?.symbol,
            company_name: (item.companies as any)?.company_name,
            sector: (item.companies as any)?.sectors?.name,
            volume: item.volume,
            value_traded: item.value_traded,
            close_price: item.close_price,
            open_price: item.open_price,
            trade_date: item.trade_date,
            change_pct,
          };
        })
        .sort((a, b) => b.change_pct - a.change_pct)
        .slice(0, 10);

      return c.json({
        success: true,
        data: ranked,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Pull insights + key figures from ingested company reports.
   * Returns `data: null` (success: true) when no documents exist for the company —
   * the client renders nothing in that case.
   */
  getDocumentInsights: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const symbol = c.req.param("symbol");
      const { psxService } = await import("../services/psx.service");

      const { data: company, error: cErr } = await supabase
        .from("companies")
        .select("id, symbol, company_name")
        .eq("symbol", symbol.toUpperCase())
        .single();

      if (cErr || !company) {
        return c.json({ success: false, error: "Company not found" }, 404);
      }

      const result = await psxService.getDocumentInsights(
        supabase,
        c.env,
        company.company_name || symbol,
        symbol,
      );

      return c.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get AI-generated "Pulse" summary for a company
   */
  getAISummary: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const symbol = c.req.param("symbol");
      const { psxService } = await import("../services/psx.service");

      // 1. Resolve company ID first
      const { data: company, error: cErr } = await supabase
        .from("companies")
        .select("id")
        .eq("symbol", symbol.toUpperCase())
        .single();

      if (cErr || !company) {
        return c.json({ success: false, error: "Company not found" }, 404);
      }

      // 2. Generate summary
      const context = await psxService.getStockPulseContext(supabase, company.id, symbol);
      const summary = await psxService.generatePulseSummary(c.env, context);

      return c.json({
        success: true,
        data: {
          summary,
          generated_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },
};
