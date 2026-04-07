/**
 * QMD Search — FTS, vector search, query expansion, reranking, RRF, snippets.
 *
 * Extracted from store.ts. All functions take Database or Store as parameters.
 */

import type { Database } from "./db.js";
import {
  LlamaCpp,
  getDefaultLlamaCpp,
  formatQueryForEmbedding,
  formatDocForEmbedding,
  type RerankDocument,
  type ILLMSession,
} from "./llm.js";
import {
  getCacheKey,
  getCachedResult,
  setCachedResult,
  getContextForFile,
  getDocid,
  DEFAULT_RERANK_MODEL,
  DEFAULT_QUERY_MODEL,
  type SearchResult,
  type ExpandedQuery,
} from "./store.js";
import { CHUNK_SIZE_CHARS } from "./chunking.js";

// =============================================================================
// Types
// =============================================================================

export type RankedResult = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
};

export type RRFContributionTrace = {
  listIndex: number;
  source: "fts" | "vec";
  queryType: "original" | "lex" | "vec" | "hyde";
  query: string;
  rank: number;
  weight: number;
  backendScore: number;
  rrfContribution: number;
};

export type RRFScoreTrace = {
  contributions: RRFContributionTrace[];
  baseScore: number;
  topRank: number;
  topRankBonus: number;
  totalScore: number;
};

export type RankedListMeta = {
  source: "fts" | "vec";
  queryType: "original" | "lex" | "vec" | "hyde";
  query: string;
};

export type SnippetResult = {
  line: number;
  snippet: string;
  linesBefore: number;
  linesAfter: number;
  snippetLines: number;
};

/** Weight for intent terms relative to query terms (1.0) in snippet scoring */
export const INTENT_WEIGHT_SNIPPET = 0.3;

/** Weight for intent terms relative to query terms (1.0) in chunk selection */
export const INTENT_WEIGHT_CHUNK = 0.5;

const INTENT_STOP_WORDS = new Set([
  "am", "an", "as", "at", "be", "by", "do", "he", "if",
  "in", "is", "it", "me", "my", "no", "of", "on", "or", "so",
  "to", "up", "us", "we",
  "all", "and", "any", "are", "but", "can", "did", "for", "get",
  "has", "her", "him", "his", "how", "its", "let", "may", "not",
  "our", "out", "the", "too", "was", "who", "why", "you",
  "also", "does", "find", "from", "have", "into", "more", "need",
  "show", "some", "tell", "that", "them", "this", "want", "what",
  "when", "will", "with", "your",
  "about", "looking", "notes", "search", "where", "which",
]);

// === FTS Search ===

function sanitizeFTS5Term(term: string): string {
  return term.replace(/[^\p{L}\p{N}']/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function buildFTS5Query(query: string): string | null {
  const positive: string[] = [];
  const negative: string[] = [];
  let i = 0;
  const s = query.trim();

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    const negated = s[i] === '-';
    if (negated) i++;

    if (s[i] === '"') {
      const start = i + 1;
      i++;
      while (i < s.length && s[i] !== '"') i++;
      const phrase = s.slice(start, i).trim();
      i++;
      if (phrase.length > 0) {
        const sanitized = phrase.split(/\s+/).map(t => sanitizeFTS5Term(t)).filter(t => t).join(' ');
        if (sanitized) {
          const ftsPhrase = `"${sanitized}"`;
          if (negated) negative.push(ftsPhrase);
          else positive.push(ftsPhrase);
        }
      }
    } else {
      const start = i;
      while (i < s.length && !/[\s"]/.test(s[i]!)) i++;
      const term = s.slice(start, i);
      const sanitized = sanitizeFTS5Term(term);
      if (sanitized) {
        const ftsTerm = `"${sanitized}"*`;
        if (negated) negative.push(ftsTerm);
        else positive.push(ftsTerm);
      }
    }
  }

  if (positive.length === 0) return null;
  let result = positive.join(' AND ');
  for (const neg of negative) {
    result = `${result} NOT ${neg}`;
  }
  return result;
}

export function validateSemanticQuery(query: string): string | null {
  if (/-\w/.test(query) || /-"/.test(query)) {
    return 'Negation (-term) is not supported in vec/hyde queries. Use lex for exclusions.';
  }
  return null;
}

export function validateLexQuery(query: string): string | null {
  if (/[\r\n]/.test(query)) {
    return 'Lex queries must be a single line. Remove newline characters or split into separate lex: lines.';
  }
  const quoteCount = (query.match(/"/g) ?? []).length;
  if (quoteCount % 2 === 1) {
    return 'Lex query has an unmatched double quote ("). Add the closing quote or remove it.';
  }
  return null;
}

export function searchFTS(db: Database, query: string, limit: number = 20, collectionName?: string): SearchResult[] {
  const ftsQuery = buildFTS5Query(query);
  if (!ftsQuery) return [];

  let sql = `
    SELECT
      'qmd://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title, content.doc as body, d.hash,
      bm25(documents_fts, 2.0, 5.0, 1.0) as bm25_score
    FROM documents_fts f
    JOIN documents d ON d.id = f.rowid
    JOIN content ON content.hash = d.hash
    WHERE documents_fts MATCH ? AND d.active = 1
  `;
  const params: (string | number)[] = [ftsQuery];
  if (collectionName) { sql += ` AND d.collection = ?`; params.push(String(collectionName)); }
  sql += ` ORDER BY bm25_score ASC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as { filepath: string; display_path: string; title: string; body: string; hash: string; bm25_score: number }[];
  return rows.map(row => {
    const collectionName = row.filepath.split('//')[1]?.split('/')[0] || "";
    const rawScore = Math.abs(row.bm25_score) / (1 + Math.abs(row.bm25_score));
    const score = rawScore < 0.01 ? 0.01 : rawScore;
    return {
      filepath: row.filepath, displayPath: row.display_path, title: row.title,
      hash: row.hash, docid: getDocid(row.hash), collectionName,
      modifiedAt: "", bodyLength: row.body.length, body: row.body,
      context: getContextForFile(db, row.filepath), score, source: "fts" as const,
    };
  });
}

export async function searchVec(db: Database, query: string, model: string, limit: number = 20, collectionName?: string, session?: ILLMSession, precomputedEmbedding?: number[], vecAvailable?: boolean): Promise<SearchResult[]> {
  if (vecAvailable === false) return [];
  const embedding = precomputedEmbedding ?? await getEmbedding(query, model, true, session);
  if (!embedding) return [];

  let vecResults: { hash_seq: string; distance: number }[];
  try {
    vecResults = db.prepare(`
      SELECT hash_seq, distance FROM vectors_vec WHERE embedding MATCH ? AND k = ?
    `).all(new Float32Array(embedding), limit * 3) as { hash_seq: string; distance: number }[];
  } catch {
    return [];
  }
  if (vecResults.length === 0) return [];

  const hashSeqs = vecResults.map(r => r.hash_seq);
  const distanceMap = new Map(vecResults.map(r => [r.hash_seq, r.distance]));
  const placeholders = hashSeqs.map(() => '?').join(',');
  let docSql = `
    SELECT cv.hash || '_' || cv.seq as hash_seq, cv.hash, cv.pos,
      'qmd://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path, d.title, content.doc as body
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash AND d.active = 1
    JOIN content ON content.hash = d.hash
    WHERE cv.hash || '_' || cv.seq IN (${placeholders})
  `;
  const params: string[] = [...hashSeqs];
  if (collectionName) { docSql += ` AND d.collection = ?`; params.push(collectionName); }

  const docRows = db.prepare(docSql).all(...params) as {
    hash_seq: string; hash: string; pos: number; filepath: string;
    display_path: string; title: string; body: string;
  }[];

  const seen = new Map<string, { row: typeof docRows[0]; bestDist: number }>();
  for (const row of docRows) {
    const distance = distanceMap.get(row.hash_seq) ?? 1;
    const existing = seen.get(row.filepath);
    if (!existing || distance < existing.bestDist) {
      seen.set(row.filepath, { row, bestDist: distance });
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => a.bestDist - b.bestDist)
    .slice(0, limit)
    .map(({ row, bestDist }) => {
      const collectionName = row.filepath.split('//')[1]?.split('/')[0] || "";
      return {
        filepath: row.filepath, displayPath: row.display_path, title: row.title,
        hash: row.hash, docid: getDocid(row.hash), collectionName,
        modifiedAt: "", bodyLength: row.body.length, body: row.body,
        context: getContextForFile(db, row.filepath),
        score: 1 - bestDist, source: "vec" as const, chunkPos: row.pos,
      };
    });
}

async function getEmbedding(text: string, model: string, isQuery: boolean, session?: ILLMSession, llmOverride?: LlamaCpp): Promise<number[] | null> {
  const formattedText = isQuery ? formatQueryForEmbedding(text, model) : formatDocForEmbedding(text, undefined, model);
  const result = session
    ? await session.embed(formattedText, { model, isQuery })
    : await (llmOverride ?? getDefaultLlamaCpp()).embed(formattedText, { model, isQuery });
  return result?.embedding || null;
}

export async function expandQuery(query: string, model: string = DEFAULT_QUERY_MODEL, db: Database, intent?: string, llmOverride?: LlamaCpp): Promise<ExpandedQuery[]> {
  const cacheKey = getCacheKey("expandQuery", { query, model, ...(intent && { intent }) });
  const cached = getCachedResult(db, cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as any[];
      let cachedExpanded: ExpandedQuery[];
      if (parsed.length > 0 && parsed[0].query) cachedExpanded = parsed as ExpandedQuery[];
      else if (parsed.length > 0 && parsed[0].text) cachedExpanded = parsed.map((r: any) => ({ type: r.type, query: r.text }));
      else cachedExpanded = [];
      if (cachedExpanded.length > 0) {
        const cachedSeen = new Set<string>();
        return cachedExpanded.filter(r => {
          const key = `${r.type}:${r.query}`;
          if (cachedSeen.has(key)) return false;
          cachedSeen.add(key);
          return true;
        });
      }
    } catch { /* re-expand */ }
  }
  const llm = llmOverride ?? getDefaultLlamaCpp();
  const results = await llm.expandQuery(query, { intent });
  const seen = new Set<string>();
  const expanded: ExpandedQuery[] = results
    .filter(r => r.text !== query)
    .map(r => ({ type: r.type, query: r.text }))
    .filter(r => {
      const key = `${r.type}:${r.query}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (expanded.length > 0) setCachedResult(db, cacheKey, JSON.stringify(expanded));
  return expanded;
}

export async function rerank(query: string, documents: { file: string; text: string }[], model: string = DEFAULT_RERANK_MODEL, db: Database, intent?: string, llmOverride?: LlamaCpp): Promise<{ file: string; score: number }[]> {
  const rerankQuery = intent ? `${intent}\n\n${query}` : query;
  const scoreByFileChunk: Map<string, number> = new Map();
  const uncachedDocs: RerankDocument[] = [];

  const docKey = (file: string, text: string) => `${file}\0${text}`;

  for (const doc of documents) {
    const ck = getCacheKey("rerank", { query: rerankQuery, model, chunk: doc.text });
    const legacyCk = getCacheKey("rerank", { query, file: doc.file, model, chunk: doc.text });
    const cached = getCachedResult(db, ck) ?? getCachedResult(db, legacyCk);
    if (cached !== null) {
      const score = parseFloat(cached);
      scoreByFileChunk.set(docKey(doc.file, doc.text), Number.isFinite(score) ? score : 0);
    } else {
      uncachedDocs.push({ file: doc.file, text: doc.text });
    }
  }

  if (uncachedDocs.length > 0) {
    const llm = llmOverride ?? getDefaultLlamaCpp();
    const rerankResult = await llm.rerank(rerankQuery, uncachedDocs, { model });
    const textByFile = new Map(uncachedDocs.map(d => [d.file, d.text]));
    for (const result of rerankResult.results) {
      const chunk = textByFile.get(result.file) || "";
      const ck = getCacheKey("rerank", { query: rerankQuery, model, chunk });
      setCachedResult(db, ck, result.score.toString());
      scoreByFileChunk.set(docKey(result.file, chunk), result.score);
    }
  }

  return documents
    .map(doc => ({ file: doc.file, score: scoreByFileChunk.get(docKey(doc.file, doc.text)) || 0 }))
    .sort((a, b) => b.score - a.score);
}

export function reciprocalRankFusion(
  resultLists: RankedResult[][], weights: number[] = [], k: number = 60
): RankedResult[] {
  const scores = new Map<string, { result: RankedResult; rrfScore: number; topRank: number }>();
  for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
    const list = resultLists[listIdx];
    if (!list) continue;
    const weight = weights[listIdx] ?? 1.0;
    for (let rank = 0; rank < list.length; rank++) {
      const result = list[rank];
      if (!result) continue;
      const rrfContribution = weight / (k + rank + 1);
      const existing = scores.get(result.file);
      if (existing) {
        existing.rrfScore += rrfContribution;
        existing.topRank = Math.min(existing.topRank, rank);
      } else {
        scores.set(result.file, { result, rrfScore: rrfContribution, topRank: rank });
      }
    }
  }
  for (const entry of scores.values()) {
    if (entry.topRank === 0) entry.rrfScore += 0.05;
    else if (entry.topRank <= 2) entry.rrfScore += 0.02;
  }
  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(e => ({ ...e.result, score: e.rrfScore }));
}

export function buildRrfTrace(
  resultLists: RankedResult[][], weights: number[] = [],
  listMeta: RankedListMeta[] = [], k: number = 60
): Map<string, RRFScoreTrace> {
  const traces = new Map<string, RRFScoreTrace>();
  for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
    const list = resultLists[listIdx];
    if (!list) continue;
    const weight = weights[listIdx] ?? 1.0;
    const meta = listMeta[listIdx] ?? { source: "fts", queryType: "original", query: "" } as const;
    for (let rank0 = 0; rank0 < list.length; rank0++) {
      const result = list[rank0];
      if (!result) continue;
      const rank = rank0 + 1;
      const contribution = weight / (k + rank);
      const existing = traces.get(result.file);
      const detail: RRFContributionTrace = {
        listIndex: listIdx, source: meta.source, queryType: meta.queryType,
        query: meta.query, rank, weight, backendScore: result.score, rrfContribution: contribution,
      };
      if (existing) {
        existing.baseScore += contribution;
        existing.topRank = Math.min(existing.topRank, rank);
        existing.contributions.push(detail);
      } else {
        traces.set(result.file, {
          contributions: [detail], baseScore: contribution,
          topRank: rank, topRankBonus: 0, totalScore: 0,
        });
      }
    }
  }
  for (const trace of traces.values()) {
    let bonus = 0;
    if (trace.topRank === 1) bonus = 0.05;
    else if (trace.topRank <= 3) bonus = 0.02;
    trace.topRankBonus = bonus;
    trace.totalScore = trace.baseScore + bonus;
  }
  return traces;
}

export function extractIntentTerms(intent: string): string[] {
  return intent.toLowerCase().split(/\s+/)
    .map(t => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(t => t.length > 1 && !INTENT_STOP_WORDS.has(t));
}

export function extractSnippet(body: string, query: string, maxLen = 500, chunkPos?: number, chunkLen?: number, intent?: string): SnippetResult {
  const totalLines = body.split('\n').length;
  let searchBody = body;
  let lineOffset = 0;
  if (chunkPos && chunkPos > 0) {
    const searchLen = chunkLen || CHUNK_SIZE_CHARS;
    const contextStart = Math.max(0, chunkPos - 100);
    const contextEnd = Math.min(body.length, chunkPos + searchLen + 100);
    searchBody = body.slice(contextStart, contextEnd);
    if (contextStart > 0) lineOffset = body.slice(0, contextStart).split('\n').length - 1;
  }
  const lines = searchBody.split('\n');
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  const intentTerms = intent ? extractIntentTerms(intent) : [];
  let bestLine = 0, bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineLower = (lines[i] ?? "").toLowerCase();
    let score = 0;
    for (const term of queryTerms) { if (lineLower.includes(term)) score += 1.0; }
    for (const term of intentTerms) { if (lineLower.includes(term)) score += INTENT_WEIGHT_SNIPPET; }
    if (score > bestScore) { bestScore = score; bestLine = i; }
  }
  const start = Math.max(0, bestLine - 1);
  const end = Math.min(lines.length, bestLine + 3);
  const snippetLines = lines.slice(start, end);
  let snippetText = snippetLines.join('\n');
  if (chunkPos && chunkPos > 0 && snippetText.trim().length === 0) {
    return extractSnippet(body, query, maxLen, undefined, undefined, intent);
  }
  if (snippetText.length > maxLen) snippetText = snippetText.substring(0, maxLen - 3) + "...";
  const absoluteStart = lineOffset + start + 1;
  const snippetLineCount = snippetLines.length;
  const linesBefore = absoluteStart - 1;
  const linesAfter = totalLines - (absoluteStart + snippetLineCount - 1);
  return {
    line: lineOffset + bestLine + 1, snippet: snippetText,
    linesBefore, linesAfter, snippetLines: snippetLineCount,
  };
}

export function addLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n');
  return lines.map((line, i) => `${startLine + i}: ${line}`).join('\n');
}
