/**
 * Smart Chunking — break point detection and document chunking.
 *
 * Extracted from store.ts. Pure functions with no store/DB dependency.
 * Only external dependency: getDefaultLlamaCpp() from llm.ts (for token-based chunking).
 */

import { getDefaultLlamaCpp } from "./llm.js";

// =============================================================================
// Configuration
// =============================================================================

// Chunking: 900 tokens per chunk with 15% overlap
// Increased from 800 to accommodate smart chunking finding natural break points
export const CHUNK_SIZE_TOKENS = 900;
export const CHUNK_OVERLAP_TOKENS = Math.floor(CHUNK_SIZE_TOKENS * 0.15);  // 135 tokens (15% overlap)
// Fallback char-based approximation for sync chunking (~4 chars per token)
export const CHUNK_SIZE_CHARS = CHUNK_SIZE_TOKENS * 4;  // 3600 chars
export const CHUNK_OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * 4;  // 540 chars
// Search window for finding optimal break points (in tokens, ~200 tokens)
export const CHUNK_WINDOW_TOKENS = 200;
export const CHUNK_WINDOW_CHARS = CHUNK_WINDOW_TOKENS * 4;  // 800 chars

// =============================================================================
// Break Point Detection
// =============================================================================

/**
 * A potential break point in the document with a base score indicating quality.
 */
export interface BreakPoint {
  pos: number;    // character position
  score: number;  // base score (higher = better break point)
  type: string;   // for debugging: 'h1', 'h2', 'blank', etc.
}

/**
 * A region where a code fence exists (between ``` markers).
 * We should never split inside a code fence.
 */
export interface CodeFenceRegion {
  start: number;  // position of opening ```
  end: number;    // position of closing ``` (or document end if unclosed)
}

/**
 * Patterns for detecting break points in markdown documents.
 * Higher scores indicate better places to split.
 * Scores are spread wide so headings decisively beat lower-quality breaks.
 * Order matters for scoring - more specific patterns first.
 */
export const BREAK_PATTERNS: [RegExp, number, string][] = [
  [/(?:^|\n)#{1}(?!#)/gm, 100, 'h1'],     // # but not ##
  [/(?:^|\n)#{2}(?!#)/gm, 90, 'h2'],      // ## but not ###
  [/(?:^|\n)#{3}(?!#)/gm, 80, 'h3'],      // ### but not ####
  [/(?:^|\n)#{4}(?!#)/gm, 70, 'h4'],      // #### but not #####
  [/(?:^|\n)#{5}(?!#)/gm, 60, 'h5'],      // ##### but not ######
  [/(?:^|\n)#{6}(?!#)/gm, 50, 'h6'],      // ######
  [/(?:^|\n)```/gm, 80, 'codeblock'],     // code block boundary (same as h3)
  [/\n(?:---|\*\*\*|___)\s*\n/g, 60, 'hr'],  // horizontal rule
  [/\n\n+/g, 20, 'blank'],         // paragraph boundary
  [/\n[-*]\s/g, 5, 'list'],        // unordered list item
  [/\n\d+\.\s/g, 5, 'numlist'],    // ordered list item
  [/\n/g, 1, 'newline'],           // minimal break
];

/**
 * Scan text for all potential break points.
 * Returns sorted array of break points with higher-scoring patterns taking precedence
 * when multiple patterns match the same position.
 */
export function scanBreakPoints(text: string): BreakPoint[] {
  const points: BreakPoint[] = [];
  const seen = new Map<number, BreakPoint>();  // pos -> best break point at that pos

  for (const [pattern, score, type] of BREAK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const pos = match.index!;
      const existing = seen.get(pos);
      // Keep higher score if position already seen
      if (!existing || score > existing.score) {
        const bp = { pos, score, type };
        seen.set(pos, bp);
      }
    }
  }

  // Convert to array and sort by position
  for (const bp of seen.values()) {
    points.push(bp);
  }
  return points.sort((a, b) => a.pos - b.pos);
}

/**
 * Find all code fence regions in the text.
 * Code fences are delimited by ``` and we should never split inside them.
 */
export function findCodeFences(text: string): CodeFenceRegion[] {
  const regions: CodeFenceRegion[] = [];
  const fencePattern = /(?:^|\n)```/gm;
  let inFence = false;
  let fenceStart = 0;

  for (const match of text.matchAll(fencePattern)) {
    if (!inFence) {
      fenceStart = match.index!;
      inFence = true;
    } else {
      regions.push({ start: fenceStart, end: match.index! + match[0].length });
      inFence = false;
    }
  }

  // Handle unclosed fence - extends to end of document
  if (inFence) {
    regions.push({ start: fenceStart, end: text.length });
  }

  return regions;
}

/**
 * Check if a position is inside a code fence region.
 */
export function isInsideCodeFence(pos: number, fences: CodeFenceRegion[]): boolean {
  return fences.some(f => pos > f.start && pos < f.end);
}

/**
 * Find the best cut position using scored break points with distance decay.
 *
 * Uses squared distance for gentler early decay - headings far back still win
 * over low-quality breaks near the target.
 */
export function findBestCutoff(
  breakPoints: BreakPoint[],
  targetCharPos: number,
  windowChars: number = CHUNK_WINDOW_CHARS,
  decayFactor: number = 0.7,
  codeFences: CodeFenceRegion[] = []
): number {
  const windowStart = targetCharPos - windowChars;
  let bestScore = -1;
  let bestPos = targetCharPos;

  for (const bp of breakPoints) {
    if (bp.pos < windowStart) continue;
    if (bp.pos > targetCharPos) break;  // sorted, so we can stop

    // Skip break points inside code fences
    if (isInsideCodeFence(bp.pos, codeFences)) continue;

    const distance = targetCharPos - bp.pos;
    const normalizedDist = distance / windowChars;
    const multiplier = 1.0 - (normalizedDist * normalizedDist) * decayFactor;
    const finalScore = bp.score * multiplier;

    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestPos = bp.pos;
    }
  }

  return bestPos;
}

// =============================================================================
// Document Chunking
// =============================================================================

export function chunkDocument(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS
): { text: string; pos: number }[] {
  if (content.length <= maxChars) {
    return [{ text: content, pos: 0 }];
  }

  // Pre-scan all break points and code fences once
  const breakPoints = scanBreakPoints(content);
  const codeFences = findCodeFences(content);

  const chunks: { text: string; pos: number }[] = [];
  let charPos = 0;

  while (charPos < content.length) {
    const targetEndPos = Math.min(charPos + maxChars, content.length);
    let endPos = targetEndPos;

    if (endPos < content.length) {
      const bestCutoff = findBestCutoff(breakPoints, targetEndPos, windowChars, 0.7, codeFences);
      if (bestCutoff > charPos && bestCutoff <= targetEndPos) {
        endPos = bestCutoff;
      }
    }

    if (endPos <= charPos) {
      endPos = Math.min(charPos + maxChars, content.length);
    }

    chunks.push({ text: content.slice(charPos, endPos), pos: charPos });

    if (endPos >= content.length) break;
    charPos = endPos - overlapChars;
    const lastChunkPos = chunks.at(-1)!.pos;
    if (charPos <= lastChunkPos) {
      charPos = endPos;
    }
  }

  return chunks;
}

/**
 * Chunk a document by actual token count using the LLM tokenizer.
 * More accurate than character-based chunking but requires async.
 */
export async function chunkDocumentByTokens(
  content: string,
  maxTokens: number = CHUNK_SIZE_TOKENS,
  overlapTokens: number = CHUNK_OVERLAP_TOKENS,
  windowTokens: number = CHUNK_WINDOW_TOKENS
): Promise<{ text: string; pos: number; tokens: number }[]> {
  const llm = getDefaultLlamaCpp();

  const avgCharsPerToken = 3;
  const maxChars = maxTokens * avgCharsPerToken;
  const overlapChars = overlapTokens * avgCharsPerToken;
  const windowChars = windowTokens * avgCharsPerToken;

  let charChunks = chunkDocument(content, maxChars, overlapChars, windowChars);

  const results: { text: string; pos: number; tokens: number }[] = [];

  for (const chunk of charChunks) {
    const tokens = await llm.tokenize(chunk.text);

    if (tokens.length <= maxTokens) {
      results.push({ text: chunk.text, pos: chunk.pos, tokens: tokens.length });
    } else {
      const actualCharsPerToken = chunk.text.length / tokens.length;
      const safeMaxChars = Math.floor(maxTokens * actualCharsPerToken * 0.95);

      const subChunks = chunkDocument(chunk.text, safeMaxChars, Math.floor(overlapChars * actualCharsPerToken / 2), Math.floor(windowChars * actualCharsPerToken / 2));

      for (const subChunk of subChunks) {
        const subTokens = await llm.tokenize(subChunk.text);
        results.push({
          text: subChunk.text,
          pos: chunk.pos + subChunk.pos,
          tokens: subTokens.length,
        });
      }
    }
  }

  return results;
}
