import { getSupabaseClient } from "../db";
import { AppContext, successResponse, errorResponse } from "../types";

/**
 * Health Controller - Handles health check and system status endpoints
 */
export const healthController = {
  /**
   * Basic health check
   */
  healthCheck: (c: AppContext) => {
    return c.json({
      status: "healthy",
      service: "spine",
      timestamp: new Date().toISOString(),
    });
  },

  /**
   * Database connection test
   */
  dbTest: async (c: AppContext) => {
    try {
      const supabase = getSupabaseClient(c.env);
      const { data, error } = await supabase
        .from("sectors")
        .select("*")
        .limit(5);

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      return c.json(successResponse(data));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Simple message endpoint
   */
  message: (c: AppContext) => {
    return c.text("Hello from Spine API!");
  },

  /**
   * Financial tips endpoint
   */
  financialTips: (c: AppContext) => {
    const tips = [
      {
        id: 1,
        title: "Start an Emergency Fund",
        description: "Save 3-6 months of expenses for unexpected situations",
        category: "savings",
        priority: "high",
      },
      {
        id: 2,
        title: "Track Your Expenses",
        description:
          "Monitor where your money goes each month to identify saving opportunities",
        category: "budgeting",
        priority: "high",
      },
      {
        id: 3,
        title: "Invest Early",
        description:
          "Start investing as early as possible to benefit from compound interest",
        category: "investing",
        priority: "medium",
      },
    ];

    return c.json(successResponse(tips));
  },
};
