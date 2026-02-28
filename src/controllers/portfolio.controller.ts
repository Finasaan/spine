import { getSupabaseAdminClient } from "../db";
import { AppContext, successResponse, errorResponse } from "../types";

/**
 * Portfolio Controller
 * Handles CRUD operations for user portfolios and holdings,
 * plus computed portfolio summary/dashboard data.
 *
 * Covers PRD features:
 *   P-1: Create Portfolio
 *   P-2: Add Stock Holdings (symbol, quantity, purchase price, date)
 *   P-3: Add Mutual Fund Holdings (fund, units, NAV at purchase, date)
 *   P-4: Portfolio Dashboard (total value, P/L, daily change, allocation)
 *   P-5: Holdings Table (current price, avg cost, quantity, P/L, weight %)
 */
export const portfolioController = {
  // ========================================
  // Portfolio CRUD (P-1)
  // ========================================

  /**
   * GET /portfolio
   * List all portfolios for the authenticated user with summary stats.
   */
  listPortfolios: async (c: AppContext) => {
    try {
      const user = c.get("user");
      const supabase = await getSupabaseAdminClient(c.env);

      const { data: portfolios, error } = await supabase
        .from("user_portfolios")
        .select("id, name, description, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (error) {
        return c.json(errorResponse(error), 500);
      }

      // For each portfolio, get a quick holdings count
      const enriched = await Promise.all(
        (portfolios || []).map(async (portfolio: any) => {
          const { count } = await supabase
            .from("user_portfolio_holdings")
            .select("id", { count: "exact", head: true })
            .eq("portfolio_id", portfolio.id);

          return {
            ...portfolio,
            holdings_count: count || 0,
          };
        })
      );

      return c.json(successResponse(enriched));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * POST /portfolio
   * Create a new portfolio.
   * Body: { name: string, description?: string }
   */
  createPortfolio: async (c: AppContext) => {
    try {
      const user = c.get("user");
      const supabase = await getSupabaseAdminClient(c.env);
      const body = await c.req.json();

      const { name, description } = body;

      if (!name || typeof name !== "string" || name.trim().length === 0) {
        return c.json(
          { success: false, error: "Portfolio name is required" },
          400
        );
      }

      // Limit portfolios per user to 10
      const { count } = await supabase
        .from("user_portfolios")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id);

      if (count && count >= 10) {
        return c.json(
          { success: false, error: "Maximum 10 portfolios allowed" },
          400
        );
      }

      const { data, error } = await supabase
        .from("user_portfolios")
        .insert({
          user_id: user.id,
          name: name.trim(),
          description: description?.trim() || null,
        })
        .select()
        .single();

      if (error) {
        return c.json(errorResponse(error), 500);
      }

      return c.json(successResponse(data), 201);
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * GET /portfolio/:id
   * Get a single portfolio with its holdings.
   */
  getPortfolio: async (c: AppContext) => {
    try {
      const user = c.get("user");
      const supabase = await getSupabaseAdminClient(c.env);
      const portfolioId = c.req.param("id");

      // Verify ownership
      const { data: portfolio, error: pError } = await supabase
        .from("user_portfolios")
        .select("id, name, description, created_at")
        .eq("id", portfolioId)
        .eq("user_id", user.id)
        .single();

      if (pError || !portfolio) {
        return c.json(
          { success: false, error: "Portfolio not found" },
          404
        );
      }

      // Get holdings
      const { data: holdings, error: hError } = await supabase
        .from("user_portfolio_holdings")
        .select("id, company_id, mutual_fund_id, quantity, purchase_price, purchase_date, notes, added_at")
        .eq("portfolio_id", portfolioId)
        .order("added_at", { ascending: false });

      if (hError) {
        return c.json(errorResponse(hError), 500);
      }

      return c.json(
        successResponse({
          ...portfolio,
          holdings: holdings || [],
        })
      );
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * PUT /portfolio/:id
   * Update portfolio name/description.
   * Body: { name?: string, description?: string }
   */
  updatePortfolio: async (c: AppContext) => {
    try {
      const user = c.get("user");
      const supabase = await getSupabaseAdminClient(c.env);
      const portfolioId = c.req.param("id");
      const body = await c.req.json();

      const updates: any = {};
      if (body.name !== undefined) {
        if (typeof body.name !== "string" || body.name.trim().length === 0) {
          return c.json(
            { success: false, error: "Portfolio name cannot be empty" },
            400
          );
        }
        updates.name = body.name.trim();
      }
      if (body.description !== undefined) {
        updates.description = body.description?.trim() || null;
      }

      if (Object.keys(updates).length === 0) {
        return c.json(
          { success: false, error: "No fields to update" },
          400
        );
      }

      const { data, error } = await supabase
        .from("user_portfolios")
        .update(updates)
        .eq("id", portfolioId)
        .eq("user_id", user.id)
        .select()
        .single();

      if (error || !data) {
        return c.json(
          { success: false, error: "Portfolio not found" },
          404
        );
      }

      return c.json(successResponse(data));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * DELETE /portfolio/:id
   * Delete a portfolio and all its holdings (cascades).
   */
  deletePortfolio: async (c: AppContext) => {
    try {
      const user = c.get("user");
      const supabase = await getSupabaseAdminClient(c.env);
      const portfolioId = c.req.param("id");

      const { data, error } = await supabase
        .from("user_portfolios")
        .delete()
        .eq("id", portfolioId)
        .eq("user_id", user.id)
        .select()
        .single();

      if (error || !data) {
        return c.json(
          { success: false, error: "Portfolio not found" },
          404
        );
      }

      return c.json(successResponse({ deleted: true, id: portfolioId }));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  // ========================================
  // Holdings CRUD (P-2, P-3)
  // ========================================

  /**
   * POST /portfolio/:id/holdings
   * Add a stock or fund holding to the portfolio.
   * Body: {
   *   company_id?: string,
   *   mutual_fund_id?: string,
   *   quantity: number,
   *   purchase_price: number,
   *   purchase_date?: string (YYYY-MM-DD),
   *   notes?: string
   * }
   */
  addHolding: async (c: AppContext) => {
    try {
      const user = c.get("user");
      const supabase = await getSupabaseAdminClient(c.env);
      const portfolioId = c.req.param("id");
      const body = await c.req.json();

      // Verify portfolio ownership
      const { data: portfolio } = await supabase
        .from("user_portfolios")
        .select("id")
        .eq("id", portfolioId)
        .eq("user_id", user.id)
        .single();

      if (!portfolio) {
        return c.json(
          { success: false, error: "Portfolio not found" },
          404
        );
      }

      const { company_id, mutual_fund_id, quantity, purchase_price, purchase_date, notes } = body;

      // Validate: exactly one asset type
      if ((!company_id && !mutual_fund_id) || (company_id && mutual_fund_id)) {
        return c.json(
          { success: false, error: "Provide exactly one of company_id or mutual_fund_id" },
          400
        );
      }

      // Validate quantity and price
      if (!quantity || quantity <= 0) {
        return c.json(
          { success: false, error: "Quantity must be a positive number" },
          400
        );
      }
      if (!purchase_price || purchase_price <= 0) {
        return c.json(
          { success: false, error: "Purchase price must be a positive number" },
          400
        );
      }

      // Verify the asset exists
      if (company_id) {
        const { data: company } = await supabase
          .from("companies")
          .select("id")
          .eq("id", company_id)
          .single();
        if (!company) {
          return c.json({ success: false, error: "Company not found" }, 404);
        }
      } else {
        const { data: fund } = await supabase
          .from("mutual_funds")
          .select("id")
          .eq("id", mutual_fund_id)
          .single();
        if (!fund) {
          return c.json({ success: false, error: "Mutual fund not found" }, 404);
        }
      }

      const insertData: any = {
        portfolio_id: portfolioId,
        quantity,
        purchase_price,
        purchase_date: purchase_date || null,
        notes: notes || null,
      };

      if (company_id) {
        insertData.company_id = company_id;
      } else {
        insertData.mutual_fund_id = mutual_fund_id;
      }

      const { data, error } = await supabase
        .from("user_portfolio_holdings")
        .insert(insertData)
        .select()
        .single();

      if (error) {
        return c.json(errorResponse(error), 500);
      }

      return c.json(successResponse(data), 201);
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * PUT /portfolio/:id/holdings/:holdingId
   * Update a holding (quantity, purchase_price, purchase_date, notes).
   */
  updateHolding: async (c: AppContext) => {
    try {
      const user = c.get("user");
      const supabase = await getSupabaseAdminClient(c.env);
      const portfolioId = c.req.param("id");
      const holdingId = c.req.param("holdingId");
      const body = await c.req.json();

      // Verify portfolio ownership
      const { data: portfolio } = await supabase
        .from("user_portfolios")
        .select("id")
        .eq("id", portfolioId)
        .eq("user_id", user.id)
        .single();

      if (!portfolio) {
        return c.json(
          { success: false, error: "Portfolio not found" },
          404
        );
      }

      const updates: any = {};
      if (body.quantity !== undefined) {
        if (body.quantity <= 0) {
          return c.json(
            { success: false, error: "Quantity must be positive" },
            400
          );
        }
        updates.quantity = body.quantity;
      }
      if (body.purchase_price !== undefined) {
        if (body.purchase_price <= 0) {
          return c.json(
            { success: false, error: "Purchase price must be positive" },
            400
          );
        }
        updates.purchase_price = body.purchase_price;
      }
      if (body.purchase_date !== undefined) {
        updates.purchase_date = body.purchase_date;
      }
      if (body.notes !== undefined) {
        updates.notes = body.notes;
      }

      if (Object.keys(updates).length === 0) {
        return c.json(
          { success: false, error: "No fields to update" },
          400
        );
      }

      const { data, error } = await supabase
        .from("user_portfolio_holdings")
        .update(updates)
        .eq("id", holdingId)
        .eq("portfolio_id", portfolioId)
        .select()
        .single();

      if (error || !data) {
        return c.json(
          { success: false, error: "Holding not found" },
          404
        );
      }

      return c.json(successResponse(data));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * DELETE /portfolio/:id/holdings/:holdingId
   * Remove a holding from the portfolio.
   */
  deleteHolding: async (c: AppContext) => {
    try {
      const user = c.get("user");
      const supabase = await getSupabaseAdminClient(c.env);
      const portfolioId = c.req.param("id");
      const holdingId = c.req.param("holdingId");

      // Verify portfolio ownership
      const { data: portfolio } = await supabase
        .from("user_portfolios")
        .select("id")
        .eq("id", portfolioId)
        .eq("user_id", user.id)
        .single();

      if (!portfolio) {
        return c.json(
          { success: false, error: "Portfolio not found" },
          404
        );
      }

      const { data, error } = await supabase
        .from("user_portfolio_holdings")
        .delete()
        .eq("id", holdingId)
        .eq("portfolio_id", portfolioId)
        .select()
        .single();

      if (error || !data) {
        return c.json(
          { success: false, error: "Holding not found" },
          404
        );
      }

      return c.json(successResponse({ deleted: true, id: holdingId }));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  // ========================================
  // Portfolio Summary / Dashboard (P-4, P-5)
  // ========================================

  /**
   * GET /portfolio/:id/summary
   * Compute and return the full portfolio dashboard:
   * - Total value, total cost, total P/L (abs + %)
   * - Daily change (abs + %)
   * - Allocation breakdown (per asset)
   * - Holdings table with current price, avg cost, P/L, weight %
   */
  getPortfolioSummary: async (c: AppContext) => {
    try {
      const user = c.get("user");
      const supabase = await getSupabaseAdminClient(c.env);
      const portfolioId = c.req.param("id");

      // Verify portfolio ownership
      const { data: portfolio, error: pError } = await supabase
        .from("user_portfolios")
        .select("id, name, description, created_at")
        .eq("id", portfolioId)
        .eq("user_id", user.id)
        .single();

      if (pError || !portfolio) {
        return c.json(
          { success: false, error: "Portfolio not found" },
          404
        );
      }

      // Get all holdings
      const { data: holdings, error: hError } = await supabase
        .from("user_portfolio_holdings")
        .select("id, company_id, mutual_fund_id, quantity, purchase_price, purchase_date, notes, added_at")
        .eq("portfolio_id", portfolioId);

      if (hError) {
        return c.json(errorResponse(hError), 500);
      }

      if (!holdings || holdings.length === 0) {
        return c.json(
          successResponse({
            portfolio,
            total_value: 0,
            total_cost: 0,
            total_pl: 0,
            total_pl_pct: 0,
            daily_change: 0,
            daily_change_pct: 0,
            allocation: [],
            holdings: [],
          })
        );
      }

      // Separate stock and fund holdings
      const stockHoldings = holdings.filter((h: any) => h.company_id);
      const fundHoldings = holdings.filter((h: any) => h.mutual_fund_id);

      // ---- Fetch current stock prices ----
      const stockIds = [...new Set(stockHoldings.map((h: any) => h.company_id))];
      let stockPriceMap = new Map<string, { close_price: number; open_price: number }>();
      let stockInfoMap = new Map<string, { symbol: string; company_name: string; sector_id: string }>();

      if (stockIds.length > 0) {
        // Get company info
        const { data: companies } = await supabase
          .from("companies")
          .select("id, symbol, company_name, sector_id")
          .in("id", stockIds);

        if (companies) {
          for (const co of companies) {
            stockInfoMap.set(co.id, {
              symbol: co.symbol,
              company_name: co.company_name,
              sector_id: co.sector_id,
            });
          }
        }

        // Get latest trade date
        const { data: latestDate } = await supabase
          .from("daily_stock_data")
          .select("trade_date")
          .order("trade_date", { ascending: false })
          .limit(1)
          .single();

        if (latestDate?.trade_date) {
          const { data: priceData } = await supabase
            .from("daily_stock_data")
            .select("company_id, open_price, close_price")
            .eq("trade_date", latestDate.trade_date)
            .in("company_id", stockIds);

          if (priceData) {
            for (const p of priceData) {
              stockPriceMap.set(p.company_id, {
                close_price: Number(p.close_price),
                open_price: Number(p.open_price),
              });
            }
          }
        }
      }

      // ---- Fetch current fund NAVs ----
      const fundIds = [...new Set(fundHoldings.map((h: any) => h.mutual_fund_id))];
      let fundNavMap = new Map<string, { nav_price: number; prev_nav_price: number }>();
      let fundInfoMap = new Map<string, { symbol: string; name: string }>();

      if (fundIds.length > 0) {
        // Get fund info
        const { data: funds } = await supabase
          .from("mutual_funds")
          .select("id, symbol, name")
          .in("id", fundIds);

        if (funds) {
          for (const f of funds) {
            fundInfoMap.set(f.id, { symbol: f.symbol, name: f.name });
          }
        }

        // Get latest NAVs
        for (const fundId of fundIds) {
          const { data: navData } = await supabase
            .from("mutual_fund_nav_history")
            .select("nav_price")
            .eq("fund_id", fundId)
            .order("nav_date", { ascending: false })
            .limit(2);

          if (navData && navData.length > 0) {
            fundNavMap.set(fundId, {
              nav_price: Number(navData[0].nav_price),
              prev_nav_price: navData.length > 1 ? Number(navData[1].nav_price) : Number(navData[0].nav_price),
            });
          }
        }
      }

      // ---- Compute per-holding metrics ----
      // First, aggregate holdings by asset (multiple lots of same stock)
      interface AggregatedHolding {
        asset_id: string;
        type: "stock" | "fund";
        symbol: string | null;
        name: string | null;
        total_quantity: number;
        total_cost: number;
        current_price: number;
        prev_price: number;
        lots: Array<{
          id: string;
          quantity: number;
          purchase_price: number;
          purchase_date: string | null;
          notes: string | null;
          added_at: string;
        }>;
      }

      const aggregatedMap = new Map<string, AggregatedHolding>();

      for (const h of holdings as any[]) {
        const assetId = h.company_id || h.mutual_fund_id;
        const isStock = !!h.company_id;

        if (!aggregatedMap.has(assetId)) {
          let currentPrice = 0;
          let prevPrice = 0;
          let symbol: string | null = null;
          let name: string | null = null;

          if (isStock) {
            const priceInfo = stockPriceMap.get(assetId);
            currentPrice = priceInfo?.close_price || 0;
            prevPrice = priceInfo?.open_price || 0;
            const info = stockInfoMap.get(assetId);
            symbol = info?.symbol || null;
            name = info?.company_name || null;
          } else {
            const navInfo = fundNavMap.get(assetId);
            currentPrice = navInfo?.nav_price || 0;
            prevPrice = navInfo?.prev_nav_price || 0;
            const info = fundInfoMap.get(assetId);
            symbol = info?.symbol || null;
            name = info?.name || null;
          }

          aggregatedMap.set(assetId, {
            asset_id: assetId,
            type: isStock ? "stock" : "fund",
            symbol,
            name,
            total_quantity: 0,
            total_cost: 0,
            current_price: currentPrice,
            prev_price: prevPrice,
            lots: [],
          });
        }

        const agg = aggregatedMap.get(assetId)!;
        const qty = Number(h.quantity);
        const price = Number(h.purchase_price);
        agg.total_quantity += qty;
        agg.total_cost += qty * price;
        agg.lots.push({
          id: h.id,
          quantity: qty,
          purchase_price: price,
          purchase_date: h.purchase_date,
          notes: h.notes,
          added_at: h.added_at,
        });
      }

      // Build final holdings array with computed metrics
      const aggregatedHoldings = Array.from(aggregatedMap.values());
      let totalValue = 0;
      let totalCost = 0;
      let totalDailyChange = 0;

      const holdingsResult = aggregatedHoldings.map((agg) => {
        const currentValue = agg.total_quantity * agg.current_price;
        const avgCost = agg.total_quantity > 0 ? agg.total_cost / agg.total_quantity : 0;
        const pl = currentValue - agg.total_cost;
        const plPct = agg.total_cost > 0 ? (pl / agg.total_cost) * 100 : 0;
        const dailyChange = agg.total_quantity * (agg.current_price - agg.prev_price);
        const dailyChangePct = agg.prev_price > 0
          ? ((agg.current_price - agg.prev_price) / agg.prev_price) * 100
          : 0;

        totalValue += currentValue;
        totalCost += agg.total_cost;
        totalDailyChange += dailyChange;

        return {
          asset_id: agg.asset_id,
          type: agg.type,
          symbol: agg.symbol,
          name: agg.name,
          total_quantity: agg.total_quantity,
          avg_cost: round(avgCost, 2),
          current_price: agg.current_price,
          current_value: round(currentValue, 2),
          cost_basis: round(agg.total_cost, 2),
          pl: round(pl, 2),
          pl_pct: round(plPct, 2),
          daily_change: round(dailyChange, 2),
          daily_change_pct: round(dailyChangePct, 2),
          weight_pct: 0, // Filled in below
          lots: agg.lots,
        };
      });

      // Compute weight percentages
      for (const h of holdingsResult) {
        h.weight_pct = totalValue > 0
          ? round((h.current_value / totalValue) * 100, 2)
          : 0;
      }

      // Sort by weight descending
      holdingsResult.sort((a, b) => b.weight_pct - a.weight_pct);

      const totalPl = totalValue - totalCost;
      const totalPlPct = totalCost > 0 ? (totalPl / totalCost) * 100 : 0;
      const prevTotalValue = totalValue - totalDailyChange;
      const dailyChangePct = prevTotalValue > 0
        ? (totalDailyChange / prevTotalValue) * 100
        : 0;

      // Allocation breakdown by type
      const stockValue = holdingsResult
        .filter((h) => h.type === "stock")
        .reduce((sum, h) => sum + h.current_value, 0);
      const fundValue = holdingsResult
        .filter((h) => h.type === "fund")
        .reduce((sum, h) => sum + h.current_value, 0);

      const allocation = [
        {
          type: "stocks" as const,
          value: round(stockValue, 2),
          weight_pct: totalValue > 0 ? round((stockValue / totalValue) * 100, 2) : 0,
        },
        {
          type: "mutual_funds" as const,
          value: round(fundValue, 2),
          weight_pct: totalValue > 0 ? round((fundValue / totalValue) * 100, 2) : 0,
        },
      ];

      return c.json(
        successResponse({
          portfolio,
          total_value: round(totalValue, 2),
          total_cost: round(totalCost, 2),
          total_pl: round(totalPl, 2),
          total_pl_pct: round(totalPlPct, 2),
          daily_change: round(totalDailyChange, 2),
          daily_change_pct: round(dailyChangePct, 2),
          allocation,
          holdings: holdingsResult,
        })
      );
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },
};

// Helper: round to N decimal places
function round(value: number, decimals: number): number {
  return Number(Math.round(Number(value + "e" + decimals)) + "e-" + decimals);
}
