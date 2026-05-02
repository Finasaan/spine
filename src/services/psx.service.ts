import { SupabaseClient } from "@supabase/supabase-js";
import { createModel } from "./ai.service";
import { generateText } from "ai";
import { GROQ_MODELS } from "../types/chatbot.types";

/**
 * PSX Service - Handles complex data aggregation and AI generation for stocks
 */
export const psxService = {
  /**
   * Build a context object for the AI using all available data sources.
   * Gracefully handles missing reports/ratios.
   */
  async getStockPulseContext(supabase: SupabaseClient, companyId: string, symbol: string) {
    // 1. Fetch Company Info
    const { data: company } = await supabase
      .from("companies")
      .select("*, sectors(name)")
      .eq("id", companyId)
      .single();

    // 2. Fetch Latest 30D Price Stats
    const { data: latestPrices } = await supabase
      .from("daily_stock_data")
      .select("close_price, open_price, high_price, low_price, volume, trade_date")
      .eq("company_id", companyId)
      .order("trade_date", { ascending: false })
      .limit(30);

    const latest = latestPrices?.[0];
    const prev = latestPrices?.[1];
    const monthHigh = latestPrices?.length ? Math.max(...latestPrices.map(p => p.high_price)) : null;
    const monthLow = latestPrices?.length ? Math.min(...latestPrices.map(p => p.low_price)) : null;
    const priceChangePct = (latest && prev) ? ((latest.close_price - prev.close_price) / prev.close_price) * 100 : 0;

    // 3. Fetch Ratios
    const { data: ratios } = await supabase
      .from("company_ratios")
      .select("ratio_key, ratio_value, as_of_date")
      .eq("company_id", companyId)
      .order("as_of_date", { ascending: false })
      .limit(10);

    // 4. Fetch Latest Financial Report Line Items
    const { data: reportData } = await supabase
      .from("financial_reports")
      .select(`
        id, report_type, period_end_date,
        financial_report_line_items (
          item_key, item_label, item_value
        )
      `)
      .eq("company_id", companyId)
      .order("period_end_date", { ascending: false })
      .limit(1);

    const latestReport = reportData?.[0];
    const financials = latestReport?.financial_report_line_items || [];

    // 5. Fetch Latest Economic News (with Impact Analysis)
    const { data: news } = await supabase
      .from("economic_news")
      .select("title, ai_summary, impact_analysis, published_at")
      .contains("affected_tickers", [symbol.toUpperCase()])
      .order("published_at", { ascending: false })
      .limit(3);

    return {
      company: {
        name: company?.company_name || symbol,
        symbol: symbol,
        sector: company?.sectors?.name || "Unknown",
        description: company?.description,
      },
      metrics: {
        price: latest?.close_price,
        changePct: priceChangePct.toFixed(2) + "%",
        monthHigh,
        monthLow,
        avgVolume: latestPrices?.length 
          ? (latestPrices.reduce((sum, p) => sum + p.volume, 0) / latestPrices.length).toFixed(0)
          : null,
      },
      ratios: ratios?.map(r => ({ key: r.ratio_key, value: r.ratio_value })) || [],
      financials: financials.map(f => ({ label: f.item_label, value: f.item_value })),
      news: news?.map(n => ({
        title: n.title,
        summary: n.ai_summary,
        impact: n.impact_analysis
      })) || [],
      hasDetailedFinancials: (financials?.length || 0) > 0
    };
  },

  /**
   * Generates a 3-bullet summary using Llama 3.3.
   * Tailors tone based on data availability.
   */
  async generatePulseSummary(env: CloudflareBindings, context: any) {
    const model = createModel(env.AI_GATEWAY_TOKEN, env.AI_GATEWAY_BASE_URL, {
      id: GROQ_MODELS["llama-3.1-8b-instant"].id,
      name: GROQ_MODELS["llama-3.1-8b-instant"].name,
      provider: "groq",
      gatewayProvider: "groq",
      isPro: false,
      isEnabled: true,
      supportsToolCalling: false,
      contextWindow: 131072,
      maxOutputTokens: 1024,
      description: "Fast, accurate pulse generation"
    });

    const systemPrompt = `You are Finasaan Pulse, a high-speed financial analyst for the Pakistan Stock Exchange.
Your goal is to provide a concise, conversational, and highly insightful "Pulse" on a stock.

CRITICAL RULES:
1. THE PULSE: Combine technical price action (metrics) with real-world context (news/impact).
2. TONE: Professional, slightly energetic, but objective. Avoid dry listing of numbers; instead, interpret them.
   - Bad: 'Price is 12% below high.'
   - Good: 'Symbol is showing resilience, currently holding PKR X despite being 12% off its monthly peak.'
3. NO INVESTMENT ADVICE. Use descriptive language.
4. Exactly 3 bullet points.
5. If news is available, lead with how it affects the stock sentiment or operations.
6. If financials are available, highlight a key growth or efficiency metric.
7. Keep it under 100 words. Format as plain text with "-" for bullets.`;

    const newsContext = context.news.length > 0 
      ? context.news.map((n: any) => `Headline: ${n.title}\nSummary: ${n.summary}\nImpact: ${n.impact}`).join("\n---\n")
      : "No recent specific news found.";

    const userPrompt = `Analyze context for ${context.company.name} (${context.company.symbol}):
Sector: ${context.company.sector}
Current: ${context.metrics.price} (${context.metrics.changePct} change)
30D Range: ${context.metrics.monthLow} - ${context.metrics.monthHigh}
Financials: ${context.financials.length > 0 ? JSON.stringify(context.financials) : "N/A"}
Ratios: ${context.ratios.length > 0 ? JSON.stringify(context.ratios) : "N/A"}

RECENT NEWS & IMPACT:
${newsContext}

Pulse:`;

    const { text } = await generateText({
      model,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.2, // Lower temperature for more factual consistency
    });

    return text.trim();
  }
};
