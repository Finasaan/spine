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
  },

  /**
   * Pull insights and key figures from ingested-document chunks (finasaan_documents)
   * tagged with this company. Returns null when no chunks exist for the company —
   * the caller should treat that as "no documents ingested, render nothing".
   *
   * Llama extracts:
   *   - 2-3 short bullets of qualitative insight
   *   - 4-6 concrete figures (label, value, period) for the Company Information section
   */
  async getDocumentInsights(
    supabase: SupabaseClient,
    env: CloudflareBindings,
    companyName: string,
    symbol: string,
  ): Promise<{
    insights: string[];
    keyFigures: Array<{ label: string; value: string; period: string | null }>;
    trendNarrative: string | null;
    sources: Array<{ filename: string; period: string | null }>;
  } | null> {
    // Fetch the most recent chunks tagged with this company. We use ilike on
    // metadata->>company so the resolver-stored canonical name matches.
    const { data: chunks } = await supabase
      .from("finasaan_documents")
      .select("content, metadata")
      .eq("domain", "financials")
      .filter("metadata->>company", "ilike", `%${companyName}%`)
      .order("id", { ascending: false })
      .limit(12);

    if (!chunks || chunks.length === 0) return null;

    // Collect unique sources (filename + period) for citation
    const sourceMap = new Map<string, { filename: string; period: string | null }>();
    for (const ch of chunks) {
      const meta = (ch.metadata || {}) as Record<string, unknown>;
      const filename = (meta.filename as string) || "unknown.pdf";
      const period = (meta.period as string) || null;
      const key = `${filename}|${period ?? ""}`;
      if (!sourceMap.has(key)) sourceMap.set(key, { filename, period });
    }
    const sources = Array.from(sourceMap.values()).slice(0, 4);

    // Build the LLM prompt — feed it the chunks verbatim and ask for structured output.
    const corpus = chunks
      .map((ch, i) => {
        const meta = (ch.metadata || {}) as Record<string, unknown>;
        const period = (meta.period as string) || "unknown period";
        return `--- chunk ${i + 1} (${period}) ---\n${ch.content}`;
      })
      .join("\n\n");

    const model = createModel(env.AI_GATEWAY_TOKEN, env.AI_GATEWAY_BASE_URL, {
      id: GROQ_MODELS["llama-3.3-70b-versatile"].id,
      name: GROQ_MODELS["llama-3.3-70b-versatile"].name,
      provider: "groq",
      gatewayProvider: "groq",
      isPro: false,
      isEnabled: true,
      supportsToolCalling: false,
      contextWindow: 131072,
      maxOutputTokens: 1024,
      description: "Document insight extraction",
    });

    const systemPrompt = `You read excerpts from a Pakistan-listed company's filed financial report and extract three things in strict JSON.

Output ONLY a single JSON object with this shape — no preamble, no code fence, no commentary:
{
  "insights": ["bullet 1", "bullet 2", "bullet 3"],
  "keyFigures": [
    {"label": "Profit After Tax", "value": "Rs 23.4 billion", "period": "Q1 2026"},
    {"label": "EPS", "value": "Rs 13.00", "period": "Q1 2026"}
  ],
  "trendNarrative": "Margins are widening as interest income outpaces operating costs, while the deposit base continues to expand quarter-over-quarter."
}

Rules:
- insights: 2 to 3 short bullets. Each is one sentence. Lead with what changed or what the report says — not generic prose.
- keyFigures: 4 to 6 line items the report actually states (PAT, EPS, ROE, deposits, revenue, dividend, etc). Keep value as written including currency and unit. Use null for period when unclear.
- trendNarrative: ONE or TWO sentences (max ~45 words) that interpret what the keyFigures suggest about the company's trajectory — direction of growth, margin movement, balance-sheet expansion or contraction, momentum vs prior period. Describe the trend; do NOT recommend any action and do NOT use words like "buy", "sell", "hold", "invest", "investor", "recommend", "should", "outlook", "bullish", "bearish". Read like a neutral analyst describing the slope, not pitching the stock. If the excerpts do not support any trend statement, return an empty string.
- Do NOT invent numbers. If a figure is not in the excerpts, leave it out.
- Do NOT include investment advice or speculation about price.
- Output empty arrays / empty string if the excerpts contain no extractable financial content. Never return prose outside the JSON.`;

    const userPrompt = `Company: ${companyName} (${symbol})

Excerpts from the most recent ingested report(s):

${corpus}

JSON:`;

    let parsed: {
      insights?: unknown;
      keyFigures?: unknown;
      trendNarrative?: unknown;
    } = {};
    try {
      const { text } = await generateText({
        model,
        system: systemPrompt,
        prompt: userPrompt,
        temperature: 0.1,
      });

      // Strip any stray ```json fences the model might emit despite instructions
      const cleaned = text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();

      parsed = JSON.parse(cleaned);
    } catch {
      return null;
    }

    const insights = Array.isArray(parsed.insights)
      ? (parsed.insights as unknown[])
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .slice(0, 3)
      : [];

    const keyFigures = Array.isArray(parsed.keyFigures)
      ? (parsed.keyFigures as Array<Record<string, unknown>>)
          .filter(
            (f) =>
              typeof f.label === "string" &&
              typeof f.value === "string" &&
              (f.label as string).trim().length > 0 &&
              (f.value as string).trim().length > 0,
          )
          .slice(0, 6)
          .map((f) => ({
            label: (f.label as string).trim(),
            value: (f.value as string).trim(),
            period:
              typeof f.period === "string" && (f.period as string).trim().length > 0
                ? (f.period as string).trim()
                : null,
          }))
      : [];

    const rawNarrative =
      typeof parsed.trendNarrative === "string" ? parsed.trendNarrative.trim() : "";
    // Belt-and-suspenders: if the model slipped in an advice word despite the prompt,
    // drop the narrative rather than show it. Keeps the rest of the payload usable.
    const advicePattern = /\b(buy|sell|hold|invest|investor|recommend|should|bullish|bearish|outlook)\b/i;
    const trendNarrative =
      rawNarrative.length > 0 && !advicePattern.test(rawNarrative) ? rawNarrative : null;

    if (insights.length === 0 && keyFigures.length === 0 && !trendNarrative) return null;

    return { insights, keyFigures, trendNarrative, sources };
  },
};
