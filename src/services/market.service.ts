/**
 * Market Service
 * Handles fetching, parsing, and caching PSX market index data.
 *
 * Data source: PSX daily closing rate PDFs
 * URL pattern: https://dps.psx.com.pk/download/closing_rates/{yyyy-mm-dd}.pdf
 *
 * Parses ONLY page 1 header for KSE-100 and KSE-30 index values.
 * Caches parsed data in `market_summary` table via upsert on (trade_date, index_name).
 */

import { extractTextFromPDF } from "./pdf.service";

const PSX_PDF_BASE_URL = "https://dps.psx.com.pk/download/closing_rates";

// ---- Types ----

export interface MarketIndexData {
  index_name: string; // 'KSE100' or 'KSE30'
  trade_date: string; // 'YYYY-MM-DD'
  previous_close: number;
  current_close: number;
  net_change: number;
  change_pct: number;
  market_open_time: string | null;
  market_close_time: string | null;
}

export interface MarketSummaryResponse {
  kse100: MarketIndexData | null;
  kse30: MarketIndexData | null;
  trade_date: string;
  market_status: "open" | "closed" | "pre_market" | "post_market";
  is_stale: boolean; // true if data is from a previous day (e.g. weekend)
}

// ---- Date Logic ----

/**
 * Get the current date/time in Pakistan Standard Time (PKT = UTC+5).
 */
function getPKTNow(): Date {
  const now = new Date();
  // Convert to PKT by getting UTC time + 5 hours offset
  const pktOffset = 5 * 60; // minutes
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
  return new Date(utcMs + pktOffset * 60 * 1000);
}

/**
 * Format a date as YYYY-MM-DD string.
 */
function formatDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Determine the most likely trading date for which a PDF should be available.
 *
 * Rules:
 * - If weekday & hour >= 17 (5 PM PKT) → today (market closed, PDF should be available)
 * - If weekday & hour < 17 → previous weekday (today's PDF not yet ready)
 * - If Saturday → Friday
 * - If Sunday → Friday
 */
export function getMarketDate(): string {
  const pkt = getPKTNow();
  const dayOfWeek = pkt.getDay(); // 0=Sun, 6=Sat
  const hour = pkt.getHours();

  if (dayOfWeek === 0) {
    // Sunday → go back to Friday
    pkt.setDate(pkt.getDate() - 2);
  } else if (dayOfWeek === 6) {
    // Saturday → go back to Friday
    pkt.setDate(pkt.getDate() - 1);
  } else if (hour < 17) {
    // Weekday before 5 PM → previous weekday
    if (dayOfWeek === 1) {
      // Monday → go back to Friday
      pkt.setDate(pkt.getDate() - 3);
    } else {
      pkt.setDate(pkt.getDate() - 1);
    }
  }
  // else: weekday at/after 5 PM → today

  return formatDateStr(pkt);
}

/**
 * Get the current market status based on PKT time.
 * Market hours: 9:30 AM – 4:15 PM PKT, Mon-Fri.
 */
export function getMarketStatus(): "open" | "closed" | "pre_market" | "post_market" {
  const pkt = getPKTNow();
  const dayOfWeek = pkt.getDay();

  // Weekend
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return "closed";
  }

  const hour = pkt.getHours();
  const minute = pkt.getMinutes();
  const timeInMinutes = hour * 60 + minute;

  const marketOpen = 9 * 60 + 30; // 9:30 AM
  const marketClose = 16 * 60 + 15; // 4:15 PM

  if (timeInMinutes < marketOpen) {
    return "pre_market";
  } else if (timeInMinutes <= marketClose) {
    return "open";
  } else {
    return "post_market";
  }
}

// ---- PDF Fetching & Parsing ----

/**
 * Fetch the PSX closing rates PDF for a given date.
 * Returns the PDF as an ArrayBuffer, or null if not found (404).
 */
async function fetchPSXPdf(dateStr: string): Promise<ArrayBuffer | null> {
  const url = `${PSX_PDF_BASE_URL}/${dateStr}.pdf`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Finasaan/1.0 (Market Data Aggregator)",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null; // PDF not yet available for this date
      }
      throw new Error(`PSX PDF fetch failed: ${response.status} ${response.statusText}`);
    }

    return await response.arrayBuffer();
  } catch (error) {
    console.error(`Failed to fetch PSX PDF for ${dateStr}:`, error);
    return null;
  }
}

/**
 * Parse the raw text extracted from page 1 of a PSX closing rates PDF.
 *
 * Expected text format (from unpdf extraction):
 * ```
 * From : 09:30_AM_TO_04:15_PM
 * Friday February 27,2026
 * P.KSE100 Ind: 168893.09
 * P.KSE30 Ind: 51723.3
 * C.KSE100 Ind: 168062.17
 * C.KSE30 Ind: 51322.39 Minus: 257
 * Total: 472 Net Change: -830.92 Net Change: -400.92
 * ```
 *
 * First `Net Change` = KSE-100, second = KSE-30.
 */
export function parseMarketHeader(rawText: string): {
  kse100: Omit<MarketIndexData, "trade_date"> | null;
  kse30: Omit<MarketIndexData, "trade_date"> | null;
  marketTimes: { open: string | null; close: string | null };
} {
  const result = {
    kse100: null as Omit<MarketIndexData, "trade_date"> | null,
    kse30: null as Omit<MarketIndexData, "trade_date"> | null,
    marketTimes: { open: null as string | null, close: null as string | null },
  };

  // Parse market hours: "From : 09:30_AM_TO_04:15_PM" or variations
  const timeMatch = rawText.match(
    /From\s*:\s*(\d{1,2}:\d{2}\s*(?:AM|PM))\s*(?:_|\s)*TO\s*(?:_|\s)*(\d{1,2}:\d{2}\s*(?:AM|PM))/i
  );
  if (timeMatch) {
    result.marketTimes.open = timeMatch[1].replace(/_/g, " ").trim();
    result.marketTimes.close = timeMatch[2].replace(/_/g, " ").trim();
  }

  // Parse P.KSE100 Ind (previous close)
  const pKse100Match = rawText.match(/P\.KSE100\s+Ind:\s*([\d,.]+)/i);
  const pKse100 = pKse100Match ? parseFloat(pKse100Match[1].replace(/,/g, "")) : null;

  // Parse C.KSE100 Ind (current close)
  const cKse100Match = rawText.match(/C\.KSE100\s+Ind:\s*([\d,.]+)/i);
  const cKse100 = cKse100Match ? parseFloat(cKse100Match[1].replace(/,/g, "")) : null;

  // Parse P.KSE30 Ind (previous close)
  const pKse30Match = rawText.match(/P\.KSE30\s+Ind:\s*([\d,.]+)/i);
  const pKse30 = pKse30Match ? parseFloat(pKse30Match[1].replace(/,/g, "")) : null;

  // Parse C.KSE30 Ind (current close)
  const cKse30Match = rawText.match(/C\.KSE30\s+Ind:\s*([\d,.]+)/i);
  const cKse30 = cKse30Match ? parseFloat(cKse30Match[1].replace(/,/g, "")) : null;

  // Parse Net Change values — two occurrences on the same line
  // "Net Change: -830.92 Net Change: -400.92"
  const netChangeMatches = rawText.match(
    /Net\s+Change:\s*(-?[\d,.]+)\s+Net\s+Change:\s*(-?[\d,.]+)/i
  );

  let netChangeKse100: number | null = null;
  let netChangeKse30: number | null = null;

  if (netChangeMatches) {
    netChangeKse100 = parseFloat(netChangeMatches[1].replace(/,/g, ""));
    netChangeKse30 = parseFloat(netChangeMatches[2].replace(/,/g, ""));
  } else {
    // Fallback: try to find individual Net Change values
    const singleNetChanges = [...rawText.matchAll(/Net\s+Change:\s*(-?[\d,.]+)/gi)];
    if (singleNetChanges.length >= 1) {
      netChangeKse100 = parseFloat(singleNetChanges[0][1].replace(/,/g, ""));
    }
    if (singleNetChanges.length >= 2) {
      netChangeKse30 = parseFloat(singleNetChanges[1][1].replace(/,/g, ""));
    }
  }

  // Build KSE-100 data
  if (pKse100 !== null && cKse100 !== null) {
    const change = netChangeKse100 ?? cKse100 - pKse100;
    const changePct = pKse100 > 0 ? (change / pKse100) * 100 : 0;

    result.kse100 = {
      index_name: "KSE100",
      previous_close: pKse100,
      current_close: cKse100,
      net_change: change,
      change_pct: Math.round(changePct * 10000) / 10000, // 4 decimal places
      market_open_time: result.marketTimes.open,
      market_close_time: result.marketTimes.close,
    };
  }

  // Build KSE-30 data
  if (pKse30 !== null && cKse30 !== null) {
    const change = netChangeKse30 ?? cKse30 - pKse30;
    const changePct = pKse30 > 0 ? (change / pKse30) * 100 : 0;

    result.kse30 = {
      index_name: "KSE30",
      previous_close: pKse30,
      current_close: cKse30,
      net_change: change,
      change_pct: Math.round(changePct * 10000) / 10000,
      market_open_time: result.marketTimes.open,
      market_close_time: result.marketTimes.close,
    };
  }

  return result;
}

/**
 * Fetch and parse a PSX PDF for the given date.
 * Returns parsed index data or null if the PDF is unavailable.
 */
export async function fetchAndParseMarketData(
  dateStr: string
): Promise<{
  kse100: MarketIndexData | null;
  kse30: MarketIndexData | null;
  rawText: string;
} | null> {
  const pdfBuffer = await fetchPSXPdf(dateStr);

  if (!pdfBuffer) {
    return null;
  }

  const rawText = await extractTextFromPDF(pdfBuffer);

  if (!rawText || rawText.trim().length === 0) {
    console.error(`No text extracted from PSX PDF for ${dateStr}`);
    return null;
  }

  const parsed = parseMarketHeader(rawText);

  return {
    kse100: parsed.kse100 ? { ...parsed.kse100, trade_date: dateStr } : null,
    kse30: parsed.kse30 ? { ...parsed.kse30, trade_date: dateStr } : null,
    rawText,
  };
}

/**
 * Try fetching market data with date fallback.
 * If the primary date fails, tries up to `maxRetries` previous weekdays.
 */
export async function fetchWithFallback(
  startDate: string,
  maxRetries: number = 5
): Promise<{
  kse100: MarketIndexData | null;
  kse30: MarketIndexData | null;
  rawText: string;
  actualDate: string;
} | null> {
  let currentDate = new Date(startDate + "T00:00:00");

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const dateStr = formatDateStr(currentDate);
    const result = await fetchAndParseMarketData(dateStr);

    if (result && (result.kse100 || result.kse30)) {
      return { ...result, actualDate: dateStr };
    }

    // Go to previous weekday
    do {
      currentDate.setDate(currentDate.getDate() - 1);
    } while (currentDate.getDay() === 0 || currentDate.getDay() === 6);
  }

  return null;
}

// ---- Database Operations ----

/**
 * Upsert market index data into the `market_summary` table.
 * Uses the unique constraint on (trade_date, index_name) for conflict resolution.
 */
export async function upsertMarketData(
  supabase: any,
  data: MarketIndexData,
  rawText?: string
): Promise<void> {
  const { error } = await supabase.from("market_summary").upsert(
    {
      trade_date: data.trade_date,
      index_name: data.index_name,
      previous_close: data.previous_close,
      current_close: data.current_close,
      net_change: data.net_change,
      change_pct: data.change_pct,
      market_open_time: data.market_open_time,
      market_close_time: data.market_close_time,
      raw_text: rawText || null,
      fetched_at: new Date().toISOString(),
    },
    {
      onConflict: "trade_date,index_name",
    }
  );

  if (error) {
    console.error(`Failed to upsert market data for ${data.index_name} ${data.trade_date}:`, error);
    throw error;
  }
}

/**
 * Fetch cached market summary from database for a given date.
 * Returns both KSE-100 and KSE-30 data if available.
 */
export async function getCachedMarketData(
  supabase: any,
  tradeDate: string
): Promise<{ kse100: MarketIndexData | null; kse30: MarketIndexData | null }> {
  const { data, error } = await supabase
    .from("market_summary")
    .select("*")
    .eq("trade_date", tradeDate)
    .order("index_name", { ascending: true });

  if (error || !data || data.length === 0) {
    return { kse100: null, kse30: null };
  }

  let kse100: MarketIndexData | null = null;
  let kse30: MarketIndexData | null = null;

  for (const row of data) {
    const mapped: MarketIndexData = {
      index_name: row.index_name,
      trade_date: row.trade_date,
      previous_close: parseFloat(row.previous_close),
      current_close: parseFloat(row.current_close),
      net_change: parseFloat(row.net_change),
      change_pct: parseFloat(row.change_pct),
      market_open_time: row.market_open_time,
      market_close_time: row.market_close_time,
    };

    if (row.index_name === "KSE100") {
      kse100 = mapped;
    } else if (row.index_name === "KSE30") {
      kse30 = mapped;
    }
  }

  return { kse100, kse30 };
}

/**
 * Get the latest available market data from the database,
 * regardless of the specific date. Useful when we don't know
 * the exact last trading date.
 */
export async function getLatestCachedMarketData(
  supabase: any
): Promise<{ kse100: MarketIndexData | null; kse30: MarketIndexData | null; tradeDate: string | null }> {
  // Get the most recent trade_date
  const { data: latestRow, error } = await supabase
    .from("market_summary")
    .select("trade_date")
    .order("trade_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !latestRow) {
    return { kse100: null, kse30: null, tradeDate: null };
  }

  const cached = await getCachedMarketData(supabase, latestRow.trade_date);
  return { ...cached, tradeDate: latestRow.trade_date };
}
