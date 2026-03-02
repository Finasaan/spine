/**
 * PDF Processing Service
 * Handles PDF text extraction, per-page analysis, page rendering,
 * and text chunking for the hybrid RAG ingestion pipeline.
 */

/**
 * Extract text content from PDF buffer (all pages merged).
 * Uses unpdf for text extraction (designed for serverless/edge environments).
 */
export async function extractTextFromPDF(
  pdfBuffer: ArrayBuffer
): Promise<string> {
  const { extractText } = await import("unpdf");
  const buffer = new Uint8Array(pdfBuffer);
  const result = await extractText(buffer);
  return result.text.join("\n");
}

// ============================================================================
// Per-Page Text Extraction
// ============================================================================

/**
 * Extract text from each page individually.
 * Returns an array where index 0 = page 1's text, etc.
 *
 * Uses unpdf's extractText which returns a per-page string array natively.
 * NOTE: getDocumentProxy is NOT usable in CF Workers — it relies on pdf.js
 * internal worker messaging (structured cloning) which throws
 * "Unable to deserialize cloned data" at runtime.
 */
export async function extractPerPageTexts(
  pdfData: Uint8Array
): Promise<string[]> {
  const { extractText } = await import("unpdf");
  const result = await extractText(pdfData);
  return result.text;
}

// ============================================================================
// Page Classification
// ============================================================================

/**
 * Detect whether a page is table/numeric-heavy.
 * Used to decide if a selectable-text page should go through vision (Path B)
 * or be treated as plain prose (Path A).
 *
 * NOTE: unpdf's extractText returns each page as a single string (no newlines),
 * so line-based heuristics don't work. We use token-level analysis instead.
 */
export function isTableHeavyPage(pageText: string): boolean {
  const trimmed = pageText.trim();
  if (trimmed.length === 0) return false;

  const tokens = trimmed.match(/\S+/g) || [];
  if (tokens.length === 0) return false;

  // 1. High ratio of numeric tokens (numbers, parenthesized negatives, percentages)
  //    Financial tables have lines like "Revenue 1,234,567 987,654"
  const numericTokens = tokens.filter((t) =>
    /^[\d,]+\.?\d*$/.test(t) ||           // plain numbers: 1,234,567 or 42.5
    /^\([\d,]+\.?\d*\)$/.test(t) ||       // parenthesized negatives: (1,234)
    /^-[\d,]+\.?\d*$/.test(t) ||          // dash negatives: -1,234
    /^[\d,]+\.?\d*%$/.test(t)             // percentages: 15.5%
  ).length;

  const numericRatio = numericTokens / tokens.length;
  if (numericRatio > 0.20) return true;

  // 2. Absolute count of numeric tokens — financial pages have many numbers
  //    even if the ratio is diluted by long labels
  if (numericTokens >= 15) return true;

  // 3. Presence of financial keywords alongside numbers suggests table content
  const lowerText = trimmed.toLowerCase();
  const financialKeywords = [
    "revenue", "profit", "loss", "income", "expense", "assets",
    "liabilities", "equity", "cash", "dividend", "earnings",
    "balance sheet", "income statement", "cash flow", "financial position",
    "total", "net", "gross", "operating", "depreciation", "amortization",
    "receivable", "payable", "inventory", "share capital",
    "rupees", "pkr", "rs.", "rs ", "'000", "thousands", "millions",
  ];
  const keywordHits = financialKeywords.filter((kw) =>
    lowerText.includes(kw)
  ).length;

  // If we have some numbers AND multiple financial keywords, it's likely tabular
  if (numericTokens >= 5 && keywordHits >= 3) return true;

  // 4. Pipe-separated table formatting (may still appear in some extractors)
  const pipeCount = (trimmed.match(/\|/g) || []).length;
  if (pipeCount >= 6) return true;

  return false;
}

// ============================================================================
// Page-to-Image Rendering
// ============================================================================

/**
 * Render a single PDF page to a base64-encoded PNG string.
 *
 * KNOWN LIMITATION: This function uses getDocumentProxy from unpdf, which
 * relies on pdf.js's structured cloning and does NOT work in Cloudflare
 * Workers (throws "Unable to deserialize cloned data"). The caller MUST
 * wrap this in a try-catch and fall back to text-only vision when it fails.
 *
 * This function is kept for future compatibility if CF Workers adds support,
 * or if the code runs in a different runtime (Node.js, Deno, etc.).
 *
 * @param pdfData - PDF file as Uint8Array
 * @param pageNumber - 1-based page number
 * @param scale - Render scale (2.0 = good OCR quality without excessive size)
 * @returns base64-encoded PNG string (no data URI prefix)
 */
export async function renderPageToBase64PNG(
  pdfData: Uint8Array,
  pageNumber: number,
  scale: number = 2.0
): Promise<string> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(pdfData);
  const page = await doc.getPage(pageNumber);

  const viewport = page.getViewport({ scale });
  const canvas = new OffscreenCanvas(
    Math.floor(viewport.width),
    Math.floor(viewport.height)
  );
  const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;

  await page.render({
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Count non-whitespace characters in a string.
 * Used to detect scanned PDFs (< 200 non-whitespace chars = scanned).
 */
export function countNonWhitespace(text: string): number {
  return (text.match(/\S/g) || []).length;
}

/**
 * Text Chunker configuration
 */
interface ChunkingOptions {
  chunkSize?: number; // Characters per chunk (default: 1000)
  overlap?: number; // Overlap between chunks (default: 200)
}

/**
 * Document chunk with metadata
 */
export interface DocumentChunk {
  text: string;
  metadata: {
    company?: string;
    period?: string;
    content_type: string;
    chunk_index: number;
    total_chunks: number;
    char_start: number;
    char_end: number;
  };
}

/**
 * Chunk text into overlapping segments
 * Similar to the reference implementation but using character-based splitting
 * (since tiktoken is not available in Workers)
 */
export function chunkText(
  text: string,
  company: string | undefined,
  period: string | undefined,
  options: ChunkingOptions = {}
): DocumentChunk[] {
  const chunkSize = options.chunkSize || 1000;
  const overlap = options.overlap || 200;

  // Clean and normalize text
  const cleanedText = text
    .replace(/\s+/g, " ") // Normalize whitespace
    .replace(/\n{3,}/g, "\n\n") // Limit consecutive newlines
    .trim();

  if (!cleanedText) {
    return [];
  }

  // If text fits in one chunk, return as single chunk
  if (cleanedText.length <= chunkSize) {
    return [
      {
        text: cleanedText,
        metadata: {
          company,
          period,
          content_type: "text_chunk",
          chunk_index: 0,
          total_chunks: 1,
          char_start: 0,
          char_end: cleanedText.length,
        },
      },
    ];
  }

  // Create overlapping chunks
  const chunks: DocumentChunk[] = [];
  let startIdx = 0;
  let chunkIndex = 0;

  while (startIdx < cleanedText.length) {
    // Calculate end index
    let endIdx = Math.min(startIdx + chunkSize, cleanedText.length);

    // Try to end at a sentence boundary (. ! ?) for better context
    if (endIdx < cleanedText.length) {
      const lastSentenceEnd = cleanedText
        .slice(startIdx, endIdx)
        .search(/[.!?]\s+[A-Z]/g);
      if (lastSentenceEnd > chunkSize * 0.5) {
        endIdx = startIdx + lastSentenceEnd + 1;
      }
    }

    const chunkText = cleanedText.slice(startIdx, endIdx).trim();

    if (chunkText.length > 0) {
      chunks.push({
        text: chunkText,
        metadata: {
          company,
          period,
          content_type: "text_chunk",
          chunk_index: chunkIndex,
          total_chunks: -1, // Will update after loop
          char_start: startIdx,
          char_end: endIdx,
        },
      });
      chunkIndex++;
    }

    // Move forward with overlap
    startIdx = endIdx - overlap;

    // Ensure we make progress even if overlap is large
    if (startIdx <= chunks[chunks.length - 1]?.metadata.char_start) {
      startIdx = endIdx;
    }
  }

  // Update total_chunks in all chunks
  const totalChunks = chunks.length;
  chunks.forEach((chunk) => {
    chunk.metadata.total_chunks = totalChunks;
  });

  return chunks;
}

/**
 * Process a PDF file: extract text, chunk, and return chunks ready for embedding
 */
export async function processPDF(
  pdfBuffer: ArrayBuffer,
  company?: string,
  period?: string
): Promise<DocumentChunk[]> {
  // Step 1: Extract text from PDF
  const rawText = await extractTextFromPDF(pdfBuffer);

  if (!rawText || rawText.trim().length === 0) {
    throw new Error("No text content extracted from PDF");
  }

  // Step 2: Chunk the text
  const chunks = chunkText(rawText, company, period, {
    chunkSize: 1000, // Characters - roughly 200-250 tokens
    overlap: 200, // ~40-50 tokens overlap
  });

  if (chunks.length === 0) {
    throw new Error("No chunks generated from PDF text");
  }

  return chunks;
}
