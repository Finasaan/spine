import { getSupabaseAdminClient } from "../db";
import { AppContext, successResponse, errorResponse } from "../types";

/**
 * Watchlist Controller
 * Handles CRUD operations for user's stock/fund watchlist.
 * Uses admin client + auth middleware for per-user data isolation.
 *
 * Covers PRD features:
 *   W-1: Add/Remove from Watchlist
 *   W-2: Watchlist Page (list with live prices)
 *   D-5: Watchlist Quick View (dashboard widget)
 */
export const watchlistController = {
  /**
   * GET /watchlist
   * Get all watchlisted items for the authenticated user,
   * enriched with latest price data.
   * Query params: type (stock|fund|all, default: all)
   */
  getWatchlist: async (c: AppContext) => {
    try {
      const user = c.get("user");
      const supabase = await getSupabaseAdminClient(c.env);
      const type = c.req.query("type") || "all";

      // Fetch watchlist items
      let query = supabase
        .from("user_watchlists")
        .select("id, company_id, mutual_fund_id, notes, added_at")
        .eq("user_id", user.id)
        .order("added_at", { ascending: false });

      if (type === "stock") {
        query = query.not("company_id", "is", null);
      } else if (type === "fund") {
        query = query.not("mutual_fund_id", "is", null);
      }

      const { data: watchlistItems, error } = await query;

      if (error) {
        return c.json(errorResponse(error), 500);
      }

      if (!watchlistItems || watchlistItems.length === 0) {
        return c.json(successResponse([]));
      }

      // Separate stock and fund IDs
      const stockIds = watchlistItems
        .filter((item: any) => item.company_id)
        .map((item: any) => item.company_id);
      const fundIds = watchlistItems
        .filter((item: any) => item.mutual_fund_id)
        .map((item: any) => item.mutual_fund_id);

      // Fetch company details + latest prices for stocks
      let companiesMap = new Map<string, any>();
      if (stockIds.length > 0) {
        const { data: companies } = await supabase
          .from("companies")
          .select("id, symbol, company_name, sector_id")
          .in("id", stockIds);

        // Get latest trade date
        const { data: latestDate } = await supabase
          .from("daily_stock_data")
          .select("trade_date")
          .order("trade_date", { ascending: false })
          .limit(1)
          .single();

        let priceMap = new Map<string, any>();
        if (latestDate?.trade_date) {
          // Get latest prices AND previous day for change calc
          const { data: priceData } = await supabase
            .from("daily_stock_data")
            .select("company_id, open_price, close_price, high_price, low_price, volume")
            .eq("trade_date", latestDate.trade_date)
            .in("company_id", stockIds);

          if (priceData) {
            for (const p of priceData) {
              priceMap.set(p.company_id, {
                close_price: p.close_price,
                open_price: p.open_price,
                high_price: p.high_price,
                low_price: p.low_price,
                volume: p.volume,
                change: p.close_price - p.open_price,
                change_pct:
                  p.open_price > 0
                    ? ((p.close_price - p.open_price) / p.open_price) * 100
                    : 0,
              });
            }
          }
        }

        if (companies) {
          for (const company of companies) {
            companiesMap.set(company.id, {
              ...company,
              price_data: priceMap.get(company.id) || null,
            });
          }
        }
      }

      // Fetch fund details + latest NAV for funds
      let fundsMap = new Map<string, any>();
      if (fundIds.length > 0) {
        const { data: funds } = await supabase
          .from("mutual_funds")
          .select("id, symbol, name, provider_id, ytd, risk_profile, is_shariah_compliant")
          .in("id", fundIds);

        // Get latest NAV for each fund
        if (funds) {
          for (const fund of funds) {
            const { data: latestNav } = await supabase
              .from("mutual_fund_nav_history")
              .select("nav_date, nav_price")
              .eq("fund_id", fund.id)
              .order("nav_date", { ascending: false })
              .limit(2); // Get 2 to compute daily change

            let navData: any = null;
            if (latestNav && latestNav.length > 0) {
              navData = {
                nav_price: latestNav[0].nav_price,
                nav_date: latestNav[0].nav_date,
                change: latestNav.length > 1
                  ? latestNav[0].nav_price - latestNav[1].nav_price
                  : 0,
                change_pct: latestNav.length > 1 && latestNav[1].nav_price > 0
                  ? ((latestNav[0].nav_price - latestNav[1].nav_price) / latestNav[1].nav_price) * 100
                  : 0,
              };
            }

            fundsMap.set(fund.id, {
              ...fund,
              nav_data: navData,
            });
          }
        }
      }

      // Enrich watchlist items with details
      const enriched = watchlistItems.map((item: any) => {
        if (item.company_id) {
          const company = companiesMap.get(item.company_id);
          return {
            id: item.id,
            type: "stock" as const,
            asset_id: item.company_id,
            notes: item.notes,
            added_at: item.added_at,
            symbol: company?.symbol || null,
            name: company?.company_name || null,
            sector_id: company?.sector_id || null,
            price_data: company?.price_data || null,
          };
        } else {
          const fund = fundsMap.get(item.mutual_fund_id);
          return {
            id: item.id,
            type: "fund" as const,
            asset_id: item.mutual_fund_id,
            notes: item.notes,
            added_at: item.added_at,
            symbol: fund?.symbol || null,
            name: fund?.name || null,
            ytd: fund?.ytd || null,
            risk_profile: fund?.risk_profile || null,
            is_shariah_compliant: fund?.is_shariah_compliant || null,
            nav_data: fund?.nav_data || null,
          };
        }
      });

      return c.json(successResponse(enriched));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * POST /watchlist
   * Add a stock or fund to the user's watchlist.
   * Body: { company_id?: string, mutual_fund_id?: string, notes?: string }
   */
  addToWatchlist: async (c: AppContext) => {
    try {
      const user = c.get("user");
      const supabase = await getSupabaseAdminClient(c.env);
      const body = await c.req.json();

      const { company_id, mutual_fund_id, notes } = body;

      // Validate: exactly one of company_id or mutual_fund_id must be provided
      if ((!company_id && !mutual_fund_id) || (company_id && mutual_fund_id)) {
        return c.json(
          {
            success: false,
            error: "Provide exactly one of company_id or mutual_fund_id",
          },
          400
        );
      }

      // Verify the asset exists
      if (company_id) {
        const { data: company, error } = await supabase
          .from("companies")
          .select("id")
          .eq("id", company_id)
          .single();
        if (error || !company) {
          return c.json({ success: false, error: "Company not found" }, 404);
        }
      } else {
        const { data: fund, error } = await supabase
          .from("mutual_funds")
          .select("id")
          .eq("id", mutual_fund_id)
          .single();
        if (error || !fund) {
          return c.json({ success: false, error: "Mutual fund not found" }, 404);
        }
      }

      // Insert watchlist entry (unique index will prevent duplicates)
      const insertData: any = {
        user_id: user.id,
        notes: notes || null,
        added_at: new Date().toISOString(),
      };

      if (company_id) {
        insertData.company_id = company_id;
      } else {
        insertData.mutual_fund_id = mutual_fund_id;
      }

      const { data, error } = await supabase
        .from("user_watchlists")
        .insert(insertData)
        .select()
        .single();

      if (error) {
        // Handle duplicate entry
        if (error.code === "23505") {
          return c.json(
            { success: false, error: "Already in watchlist" },
            409
          );
        }
        return c.json(errorResponse(error), 500);
      }

      return c.json(successResponse(data), 201);
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * DELETE /watchlist/:id
   * Remove an item from the user's watchlist by watchlist entry ID.
   */
  removeFromWatchlist: async (c: AppContext) => {
    try {
      const user = c.get("user");
      const supabase = await getSupabaseAdminClient(c.env);
      const id = c.req.param("id");

      const { data, error } = await supabase
        .from("user_watchlists")
        .delete()
        .eq("id", id)
        .eq("user_id", user.id)
        .select()
        .single();

      if (error || !data) {
        return c.json(
          { success: false, error: "Watchlist item not found" },
          404
        );
      }

      return c.json(successResponse({ deleted: true, id }));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * DELETE /watchlist/asset/:assetId
   * Remove an item from the watchlist by the asset ID (company or fund UUID).
   * Useful for toggle-style "unstar" from detail pages.
   * Query params: type (stock|fund)
   */
  removeByAssetId: async (c: AppContext) => {
    try {
      const user = c.get("user");
      const supabase = await getSupabaseAdminClient(c.env);
      const assetId = c.req.param("assetId");
      const type = c.req.query("type");

      if (!type || !["stock", "fund"].includes(type)) {
        return c.json(
          { success: false, error: "Query param type must be 'stock' or 'fund'" },
          400
        );
      }

      const column = type === "stock" ? "company_id" : "mutual_fund_id";

      const { data, error } = await supabase
        .from("user_watchlists")
        .delete()
        .eq(column, assetId)
        .eq("user_id", user.id)
        .select()
        .single();

      if (error || !data) {
        return c.json(
          { success: false, error: "Watchlist item not found" },
          404
        );
      }

      return c.json(successResponse({ deleted: true, asset_id: assetId }));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * GET /watchlist/check/:assetId
   * Check if a specific asset is in the user's watchlist.
   * Query params: type (stock|fund)
   * Returns: { in_watchlist: boolean, watchlist_id?: string }
   */
  checkWatchlisted: async (c: AppContext) => {
    try {
      const user = c.get("user");
      const supabase = await getSupabaseAdminClient(c.env);
      const assetId = c.req.param("assetId");
      const type = c.req.query("type");

      if (!type || !["stock", "fund"].includes(type)) {
        return c.json(
          { success: false, error: "Query param type must be 'stock' or 'fund'" },
          400
        );
      }

      const column = type === "stock" ? "company_id" : "mutual_fund_id";

      const { data } = await supabase
        .from("user_watchlists")
        .select("id")
        .eq(column, assetId)
        .eq("user_id", user.id)
        .maybeSingle();

      return c.json(
        successResponse({
          in_watchlist: !!data,
          watchlist_id: data?.id || null,
        })
      );
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },
};
