/**
 * PDF Processing Service
 * Handles PDF text extraction and text chunking for RAG
 */

/**
 * Extract text content from PDF buffer
 * Uses unpdf for text extraction (designed for serverless/edge environments)
 */
export async function extractTextFromPDF(
  pdfBuffer: ArrayBuffer
): Promise<string> {
  // Use unpdf which is designed for Cloudflare Workers and edge environments
  const { extractText } = await import("unpdf");

  // Convert ArrayBuffer to Uint8Array for unpdf
  const buffer = new Uint8Array(pdfBuffer);

  const result = await extractText(buffer);

  // unpdf returns text as string[] (array of text per page), join with newlines
  return result.text.join("\n");
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
