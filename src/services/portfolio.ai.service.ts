import { SupabaseClient } from "@supabase/supabase-js";
import { generateText } from "ai";
import { createModel } from "./ai.service";
import { getRecentNews } from "./news.service";
import modelsConfig from "../config/models.json";
import type { ModelConfig } from "../types/chatbot.types";

const MODELS = modelsConfig as ModelConfig[];

export async function generatePortfolioAISummary(
  supabase: SupabaseClient,
  userId: string,
  env: { AI_GATEWAY_TOKEN?: string; AI_GATEWAY_BASE_URL?: string }
) {
  // 1. Fetch user's portfolios
  const { data: portfolios, error: pError } = await supabase
    .from("user_portfolios")
    .select("id, name")
    .eq("user_id", userId);

  if (pError) throw pError;
  if (!portfolios || portfolios.length === 0) {
    return { 
      summary: "You don't have any portfolios yet. Add some stocks to get an AI summary!", 
      generated_at: new Date().toISOString(), 
      tickers: [] 
    };
  }

  // 2. Fetch all holdings
  const portfolioIds = portfolios.map(p => p.id);
  const { data: holdings, error: hError } = await supabase
    .from("user_portfolio_holdings")
    .select("company_id, mutual_fund_id, quantity, purchase_price")
    .in("portfolio_id", portfolioIds);

  if (hError) throw hError;
  if (!holdings || holdings.length === 0) {
    return { 
      summary: "Your portfolios are empty. Add some holdings to see an AI analysis.", 
      generated_at: new Date().toISOString(), 
      tickers: [] 
    };
  }

  // 3. Aggregate holdings
  const stockHoldings = holdings.filter(h => h.company_id);
  const stockIds = [...new Set(stockHoldings.map(h => h.company_id))];

  let portfolioDescription = "";
  const topTickers: string[] = [];

  if (stockIds.length > 0) {
      const { data: companies } = await supabase
        .from("companies")
        .select("id, symbol, company_name")
        .in("id", stockIds);

      const { data: latestDate } = await supabase
        .from("daily_stock_data")
        .select("trade_date")
        .order("trade_date", { ascending: false })
        .limit(1)
        .single();

      if (latestDate?.trade_date) {
          const { data: priceData } = await supabase
            .from("daily_stock_data")
            .select("company_id, close_price")
            .eq("trade_date", latestDate.trade_date)
            .in("company_id", stockIds);

          const priceMap = new Map(priceData?.map(p => [p.company_id, Number(p.close_price)]));
          const companyMap = new Map(companies?.map(co => [co.id, co]));

          const aggregated = new Map<string, { qty: number, cost: number, symbol: string }>();
          for (const h of stockHoldings) {
              const co = companyMap.get(h.company_id!);
              if (!co) continue;
              const existing = aggregated.get(co.symbol) || { qty: 0, cost: 0, symbol: co.symbol };
              existing.qty += Number(h.quantity);
              existing.cost += Number(h.quantity) * Number(h.purchase_price);
              aggregated.set(co.symbol, existing);
          }

          const sortedHoldings = Array.from(aggregated.values()).map(h => {
              const companyId = stockIds.find(id => companyMap.get(id)?.symbol === h.symbol);
              const currentPrice = companyId ? (priceMap.get(companyId) || 0) : 0;
              const currentValue = h.qty * currentPrice;
              const pnl = h.cost > 0 ? ((currentValue - h.cost) / h.cost) * 100 : 0;
              return { ...h, currentPrice, currentValue, pnl };
          }).sort((a, b) => b.currentValue - a.currentValue);

          portfolioDescription = sortedHoldings.map(h => 
              `${h.symbol}: ${h.qty} shares @ PKR ${h.currentPrice.toFixed(2)} = PKR ${h.currentValue.toLocaleString()} (${h.pnl.toFixed(2)}% P/L)`
          ).join("\n");

          topTickers.push(...sortedHoldings.slice(0, 3).map(h => h.symbol));
      }
  }

  // 4. Fetch News
  let newsHeadlines = "";
  if (topTickers.length > 0) {
      for (const ticker of topTickers) {
          try {
              const news = await getRecentNews(supabase, { ticker, limit: 2 });
              if (news.articles.length > 0) {
                  newsHeadlines += news.articles.map(a => `- [${ticker}] ${a.title} (${a.sentiment})`).join("\n") + "\n";
              }
          } catch (err) {}
      }
  }

  // 5. Prompt & AI
  const prompt = `You are a financial advisor summarizing a user's stock portfolio for a Pakistani retail investor.

DOMAIN GUARDRAILS:
- You are strictly assigned to the domain of the user's portfolio and relevant market news.
- NEVER talk about anything outside this domain.
- Do not make up data or hallucinate. Base your summary ONLY on the provided holdings and news.
- You may provide analysis, but always drop a disclaimer at the end: "⚠️ Not investment advice. Always do your own research before acting."

Holdings:
${portfolioDescription || "No stock holdings data available."}

Recent relevant news:
${newsHeadlines || "No recent news found for your holdings."}

Write a 3-4 sentence portfolio health summary. Be direct, specific about top holdings and P/L, and mention any news that could affect performance. Write in plain English for a retail investor.`;

  const modelConfig = MODELS.find(m => m.id === "llama-3.3-70b-versatile") || MODELS[0];
  const model = createModel(env.AI_GATEWAY_TOKEN!, env.AI_GATEWAY_BASE_URL!, modelConfig);

  const { text } = await generateText({
      model,
      prompt,
      temperature: 0.7,
  });

  return {
      summary: text,
      generated_at: new Date().toISOString(),
      tickers: topTickers
  };
}
