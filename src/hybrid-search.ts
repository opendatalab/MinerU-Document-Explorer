/**
 * QMD Hybrid Search — orchestration over FTS, vector, RRF, reranking.
 *
 * hybridQuery(), vectorSearchQuery(), and structuredSearch() are standalone
 * functions (not Store methods) because they are orchestration over primitives.
 * They take a Store as first argument so both CLI and MCP can share the
 * identical pipeline.
 *
 * Extracted from store.ts.
 */

import type { Store, ExpandedQuery } from "./store.js";
import { DEFAULT_EMBED_MODEL } from "./store.js";
import { getDefaultLlamaCpp, formatQueryForEmbedding, type LlamaCpp } from "./llm.js";
import { chunkDocument } from "./chunking.js";
import {
  reciprocalRankFusion,
  buildRrfTrace,
  validateLexQuery,
  validateSemanticQuery,
  extractIntentTerms,
  INTENT_WEIGHT_CHUNK,
  type RankedResult,
  type RankedListMeta,
  type RRFContributionTrace,
} from "./search.js";

// =============================================================================
// Constants
// =============================================================================

export const STRONG_SIGNAL_MIN_SCORE = 0.85;
export const STRONG_SIGNAL_MIN_GAP = 0.15;
export const RERANK_CANDIDATE_LIMIT = 40;

// =============================================================================
// Internal helpers
// =============================================================================

function getLlm(store: Store): LlamaCpp {
  return store.llm ?? getDefaultLlamaCpp();
}

// =============================================================================
// Types
// =============================================================================

/**
 * Optional progress hooks for search orchestration.
 * CLI wires these to stderr for user feedback; MCP leaves them unset.
 */
export interface SearchHooks {
  /** BM25 probe found strong signal — expansion will be skipped */
  onStrongSignal?: (topScore: number) => void;
  /** Query expansion starting */
  onExpandStart?: () => void;
  /** Query expansion complete. Empty array = strong signal skip. elapsedMs = time taken. */
  onExpand?: (original: string, expanded: ExpandedQuery[], elapsedMs: number) => void;
  /** Embedding starting (vec/hyde queries) */
  onEmbedStart?: (count: number) => void;
  /** Embedding complete */
  onEmbedDone?: (elapsedMs: number) => void;
  /** Reranking is about to start */
  onRerankStart?: (chunkCount: number) => void;
  /** Reranking finished */
  onRerankDone?: (elapsedMs: number) => void;
}

export interface HybridQueryOptions {
  collection?: string;
  limit?: number;           // default 10
  minScore?: number;        // default 0
  candidateLimit?: number;  // default RERANK_CANDIDATE_LIMIT
  explain?: boolean;        // include backend/RRF/rerank score traces
  intent?: string;          // domain intent hint for disambiguation
  skipRerank?: boolean;     // skip LLM reranking, use only RRF scores
  hooks?: SearchHooks;
}

export interface HybridQueryResult {
  file: string;             // internal filepath (qmd://collection/path)
  displayPath: string;
  title: string;
  body: string;             // full document body (for snippet extraction)
  bestChunk: string;        // best chunk text
  bestChunkPos: number;     // char offset of best chunk in body
  score: number;            // blended score (full precision)
  context: string | null;   // user-set context
  docid: string;            // content hash prefix (6 chars)
  explain?: HybridQueryExplain;
}

export type HybridQueryExplain = {
  ftsScores: number[];
  vectorScores: number[];
  rrf: {
    rank: number;          // Rank after RRF fusion (1-indexed)
    positionScore: number; // 1 / rank used in position-aware blending
    weight: number;        // Position-aware RRF weight (0.75 / 0.60 / 0.40)
    baseScore: number;
    topRankBonus: number;
    totalScore: number;
    contributions: RRFContributionTrace[];
  };
  rerankScore: number;
  blendedScore: number;
};

export interface VectorSearchOptions {
  collection?: string;
  limit?: number;           // default 10
  minScore?: number;        // default 0.3
  intent?: string;          // domain intent hint for disambiguation
  hooks?: Pick<SearchHooks, 'onExpand'>;
}

export interface VectorSearchResult {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
  context: string | null;
  docid: string;
}

export interface StructuredSearchOptions {
  collections?: string[];   // Filter to specific collections (OR match)
  limit?: number;           // default 10
  minScore?: number;        // default 0
  candidateLimit?: number;  // default RERANK_CANDIDATE_LIMIT
  explain?: boolean;        // include backend/RRF/rerank score traces
  /** Domain intent hint for disambiguation — steers reranking and chunk selection */
  intent?: string;
  /** Skip LLM reranking, use only RRF scores */
  skipRerank?: boolean;
  hooks?: SearchHooks;
}

// =============================================================================
// Shared scoring, ranking, and dedup pipeline
// =============================================================================

type ChunkMap = Map<string, { chunks: { text: string; pos: number }[]; bestIdx: number }>;

interface ScoringContext {
  store: Store;
  candidates: RankedResult[];
  docChunkMap: ChunkMap;
  docidMap: Map<string, string>;
  rrfTraceByFile: Map<string, import("./search.js").RRFScoreTrace> | null;
  candidateLimit: number;
  explain: boolean;
  minScore: number;
  limit: number;
}

function buildExplainData(
  trace: import("./search.js").RRFScoreTrace | undefined,
  rrfRank: number,
  rrfScore: number,
  rrfWeight: number,
  rerankScore: number,
  blendedScore: number,
): HybridQueryExplain {
  return {
    ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
    vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
    rrf: {
      rank: rrfRank,
      positionScore: rrfScore,
      weight: rrfWeight,
      baseScore: trace?.baseScore ?? 0,
      topRankBonus: trace?.topRankBonus ?? 0,
      totalScore: trace?.totalScore ?? 0,
      contributions: trace?.contributions ?? [],
    },
    rerankScore,
    blendedScore,
  };
}

function buildResult(
  ctx: ScoringContext,
  file: string,
  displayPath: string,
  title: string,
  body: string,
  rrfRank: number,
  rerankScore: number,
): HybridQueryResult {
  const chunkInfo = ctx.docChunkMap.get(file);
  const bestIdx = chunkInfo?.bestIdx ?? 0;
  const bestChunk = chunkInfo?.chunks[bestIdx]?.text || body || "";
  const bestChunkPos = chunkInfo?.chunks[bestIdx]?.pos || 0;
  const rrfScore = 1 / rrfRank;

  let rrfWeight = 1.0;
  let blendedScore = rrfScore;
  if (rerankScore > 0) {
    if (rrfRank <= 3) rrfWeight = 0.75;
    else if (rrfRank <= 10) rrfWeight = 0.60;
    else rrfWeight = 0.40;
    blendedScore = rrfWeight * rrfScore + (1 - rrfWeight) * rerankScore;
  }

  const trace = ctx.rrfTraceByFile?.get(file);
  const explainData = ctx.explain
    ? buildExplainData(trace, rrfRank, rrfScore, rrfWeight, rerankScore, blendedScore)
    : undefined;

  return {
    file,
    displayPath,
    title,
    body,
    bestChunk,
    bestChunkPos,
    score: blendedScore,
    context: ctx.store.getContextForFile(file),
    docid: ctx.docidMap.get(file) || "",
    ...(explainData ? { explain: explainData } : {}),
  };
}

function buildSkipRerankResults(ctx: ScoringContext): HybridQueryResult[] {
  return dedupAndFilter(
    ctx.candidates.map((cand, i) =>
      buildResult(ctx, cand.file, cand.displayPath, cand.title, cand.body, i + 1, 0)
    ),
    ctx.minScore,
    ctx.limit,
  );
}

async function buildRerankResults(
  ctx: ScoringContext,
  rerankQuery: string,
  intent: string | undefined,
  hooks: SearchHooks | undefined,
): Promise<HybridQueryResult[]> {
  const chunksToRerank: { file: string; text: string }[] = [];
  for (const cand of ctx.candidates) {
    const chunkInfo = ctx.docChunkMap.get(cand.file);
    if (chunkInfo) {
      chunksToRerank.push({ file: cand.file, text: chunkInfo.chunks[chunkInfo.bestIdx]!.text });
    }
  }

  hooks?.onRerankStart?.(chunksToRerank.length);
  const rerankStart = Date.now();
  const reranked = await ctx.store.rerank(rerankQuery, chunksToRerank, undefined, intent);
  hooks?.onRerankDone?.(Date.now() - rerankStart);

  const candidateMap = new Map(ctx.candidates.map(c => [c.file, c]));
  const rrfRankMap = new Map(ctx.candidates.map((c, i) => [c.file, i + 1]));

  const blended = reranked.map(r => {
    const rrfRank = rrfRankMap.get(r.file) || ctx.candidateLimit;
    const cand = candidateMap.get(r.file);
    return buildResult(
      ctx, r.file, cand?.displayPath || "", cand?.title || "", cand?.body || "",
      rrfRank, r.score,
    );
  }).sort((a, b) => b.score - a.score);

  return dedupAndFilter(blended, ctx.minScore, ctx.limit);
}

function dedupAndFilter(
  results: HybridQueryResult[],
  minScore: number,
  limit: number,
): HybridQueryResult[] {
  const seenDocids = new Set<string>();
  const seenFiles = new Set<string>();
  return results
    .filter(r => {
      if (seenFiles.has(r.file)) return false;
      seenFiles.add(r.file);
      if (r.docid && seenDocids.has(r.docid)) return false;
      if (r.docid) seenDocids.add(r.docid);
      return true;
    })
    .filter(r => r.score >= minScore)
    .slice(0, limit);
}

function chunkAndSelectBest(
  candidates: RankedResult[],
  queryTerms: string[],
  intentTerms: string[],
): ChunkMap {
  const docChunkMap: ChunkMap = new Map();
  for (const cand of candidates) {
    const chunks = chunkDocument(cand.body);
    if (chunks.length === 0) continue;

    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < chunks.length; i++) {
      const chunkLower = chunks[i]!.text.toLowerCase();
      let score = queryTerms.reduce((acc, term) => acc + (chunkLower.includes(term) ? 1 : 0), 0);
      for (const term of intentTerms) {
        if (chunkLower.includes(term)) score += INTENT_WEIGHT_CHUNK;
      }
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    docChunkMap.set(cand.file, { chunks, bestIdx });
  }
  return docChunkMap;
}

// =============================================================================
// hybridQuery
// =============================================================================

/**
 * Hybrid search: BM25 + vector + query expansion + RRF + chunked reranking.
 *
 * Pipeline:
 * 1. BM25 probe → skip expansion if strong signal
 * 2. expandQuery() → typed query variants (lex/vec/hyde)
 * 3. Type-routed search: original→vector, lex→FTS, vec/hyde→vector
 * 4. RRF fusion → slice to candidateLimit
 * 5. chunkDocument() + keyword-best-chunk selection
 * 6. rerank on chunks (NOT full bodies — O(tokens) trap)
 * 7. Position-aware score blending (RRF rank × reranker score)
 * 8. Dedup by file, filter by minScore, slice to limit
 */
export async function hybridQuery(
  store: Store,
  query: string,
  options?: HybridQueryOptions
): Promise<HybridQueryResult[]> {
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0;
  const candidateLimit = options?.candidateLimit ?? RERANK_CANDIDATE_LIMIT;
  const collection = options?.collection;
  const explain = options?.explain ?? false;
  const intent = options?.intent;
  const skipRerank = options?.skipRerank ?? false;
  const hooks = options?.hooks;

  const rankedLists: RankedResult[][] = [];
  const rankedListMeta: RankedListMeta[] = [];
  const docidMap = new Map<string, string>(); // filepath -> docid
  const hasVectors = store.vecAvailable;

  // Step 1: BM25 probe — strong signal skips expensive LLM expansion
  // When intent is provided, disable strong-signal bypass — the obvious BM25
  // match may not be what the caller wants (e.g. "performance" with intent
  // "web page load times" should NOT shortcut to a sports-performance doc).
  const initialFts = store.searchFTS(query, 20, collection);
  const topScore = initialFts[0]?.score ?? 0;
  const secondScore = initialFts[1]?.score ?? 0;
  const hasStrongSignal = !intent && initialFts.length > 0
    && topScore >= STRONG_SIGNAL_MIN_SCORE
    && (topScore - secondScore) >= STRONG_SIGNAL_MIN_GAP;

  if (hasStrongSignal) hooks?.onStrongSignal?.(topScore);

  // Step 2: Expand query (or skip if strong signal / LLM unavailable)
  hooks?.onExpandStart?.();
  const expandStart = Date.now();
  let expanded: ExpandedQuery[];
  if (hasStrongSignal) {
    expanded = [];
  } else {
    try {
      expanded = await store.expandQuery(query, undefined, intent);
    } catch {
      expanded = [];
    }
  }

  hooks?.onExpand?.(query, expanded, Date.now() - expandStart);

  // Seed with initial FTS results (avoid re-running original query FTS)
  if (initialFts.length > 0) {
    for (const r of initialFts) docidMap.set(r.filepath, r.docid);
    rankedLists.push(initialFts.map(r => ({
      file: r.filepath, displayPath: r.displayPath,
      title: r.title, body: r.body || "", score: r.score,
    })));
    rankedListMeta.push({ source: "fts", queryType: "original", query });
  }

  // Step 3: Route searches by query type
  // 3a: Run FTS for all lex expansions right away (no LLM needed)
  for (const q of expanded) {
    if (q.type === 'lex') {
      const ftsResults = store.searchFTS(q.query, 20, collection);
      if (ftsResults.length > 0) {
        for (const r of ftsResults) docidMap.set(r.filepath, r.docid);
        rankedLists.push(ftsResults.map(r => ({
          file: r.filepath, displayPath: r.displayPath,
          title: r.title, body: r.body || "", score: r.score,
        })));
        rankedListMeta.push({ source: "fts", queryType: "lex", query: q.query });
      }
    }
  }

  // 3b: Collect all texts that need vector search (original query + vec/hyde expansions)
  if (hasVectors) {
    const vecQueries: { text: string; queryType: "original" | "vec" | "hyde" }[] = [
      { text: query, queryType: "original" },
    ];
    const seenVecTexts = new Set<string>([query]);
    for (const q of expanded) {
      if ((q.type === 'vec' || q.type === 'hyde') && !seenVecTexts.has(q.query)) {
        seenVecTexts.add(q.query);
        vecQueries.push({ text: q.query, queryType: q.type });
      }
    }

    const llm = getLlm(store);
    const textsToEmbed = vecQueries.map(q => formatQueryForEmbedding(q.text));
    hooks?.onEmbedStart?.(textsToEmbed.length);
    const embedStart = Date.now();
    const embeddings = await llm.embedBatch(textsToEmbed);
    hooks?.onEmbedDone?.(Date.now() - embedStart);

    for (let i = 0; i < vecQueries.length; i++) {
      const embedding = embeddings[i]?.embedding;
      if (!embedding) continue;

      const vecResults = await store.searchVec(
        vecQueries[i]!.text, DEFAULT_EMBED_MODEL, 20, collection,
        undefined, embedding
      );
      if (vecResults.length > 0) {
        for (const r of vecResults) docidMap.set(r.filepath, r.docid);
        rankedLists.push(vecResults.map(r => ({
          file: r.filepath, displayPath: r.displayPath,
          title: r.title, body: r.body || "", score: r.score,
        })));
        rankedListMeta.push({
          source: "vec",
          queryType: vecQueries[i]!.queryType,
          query: vecQueries[i]!.text,
        });
      }
    }
  }

  // Step 4: RRF fusion — boost original FTS and original vector lists (2x weight)
  const weights = rankedListMeta.map(meta =>
    (meta.queryType === "original") ? 2.0 : 1.0
  );
  const fused = reciprocalRankFusion(rankedLists, weights);
  const rrfTraceByFile = explain ? buildRrfTrace(rankedLists, weights, rankedListMeta) : null;
  const candidates = fused.slice(0, candidateLimit);

  if (candidates.length === 0) return [];

  // Step 5: Chunk documents, pick best chunk per doc for reranking.
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const intentTerms = intent ? extractIntentTerms(intent) : [];
  const docChunkMap = chunkAndSelectBest(candidates, queryTerms, intentTerms);

  const ctx: ScoringContext = {
    store, candidates, docChunkMap, docidMap,
    rrfTraceByFile, candidateLimit, explain, minScore, limit,
  };

  if (skipRerank) return buildSkipRerankResults(ctx);

  try {
    return await buildRerankResults(ctx, query, intent, hooks);
  } catch {
    return buildSkipRerankResults(ctx);
  }
}

// =============================================================================
// vectorSearchQuery
// =============================================================================

/**
 * Vector-only semantic search with query expansion.
 *
 * Pipeline:
 * 1. expandQuery() → typed variants, filter to vec/hyde only (lex irrelevant here)
 * 2. searchVec() for original + vec/hyde variants (sequential — node-llama-cpp embed limitation)
 * 3. Dedup by filepath (keep max score)
 * 4. Sort by score descending, filter by minScore, slice to limit
 */
export async function vectorSearchQuery(
  store: Store,
  query: string,
  options?: VectorSearchOptions
): Promise<VectorSearchResult[]> {
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0.3;
  const collection = options?.collection;
  const intent = options?.intent;

  if (!store.vecAvailable) return [];

  const expandStart = Date.now();
  let vecExpanded: ExpandedQuery[];
  try {
    const allExpanded = await store.expandQuery(query, undefined, intent);
    vecExpanded = allExpanded.filter(q => q.type !== 'lex');
  } catch {
    vecExpanded = [];
  }
  options?.hooks?.onExpand?.(query, vecExpanded, Date.now() - expandStart);

  const queryTexts = [query, ...new Set(vecExpanded.map(q => q.query))];
  const allResults = new Map<string, VectorSearchResult>();
  for (const q of queryTexts) {
    const vecResults = await store.searchVec(q, DEFAULT_EMBED_MODEL, limit, collection);
    for (const r of vecResults) {
      const existing = allResults.get(r.filepath);
      if (!existing || r.score > existing.score) {
        allResults.set(r.filepath, {
          file: r.filepath,
          displayPath: r.displayPath,
          title: r.title,
          body: r.body || "",
          score: r.score,
          context: store.getContextForFile(r.filepath),
          docid: r.docid,
        });
      }
    }
  }

  return Array.from(allResults.values())
    .sort((a, b) => b.score - a.score)
    .filter(r => r.score >= minScore)
    .slice(0, limit);
}

// =============================================================================
// structuredSearch
// =============================================================================

/**
 * Structured search: execute pre-expanded queries without LLM query expansion.
 *
 * Designed for LLM callers (MCP/HTTP) that generate their own query expansions.
 * Skips the internal expandQuery() step — goes directly to:
 *
 * Pipeline:
 * 1. Route searches: lex→FTS, vec/hyde→vector (batch embed)
 * 2. RRF fusion across all result lists
 * 3. Chunk documents + keyword-best-chunk selection
 * 4. Rerank on chunks
 * 5. Position-aware score blending
 * 6. Dedup, filter, slice
 */
export async function structuredSearch(
  store: Store,
  searches: ExpandedQuery[],
  options?: StructuredSearchOptions
): Promise<HybridQueryResult[]> {
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0;
  const candidateLimit = options?.candidateLimit ?? RERANK_CANDIDATE_LIMIT;
  const explain = options?.explain ?? false;
  const intent = options?.intent;
  const skipRerank = options?.skipRerank ?? false;
  const hooks = options?.hooks;

  const collections = options?.collections;

  if (searches.length === 0) return [];

  for (const search of searches) {
    const location = search.line ? `Line ${search.line}` : 'Structured search';
    if (/[\r\n]/.test(search.query)) {
      throw new Error(`${location} (${search.type}): queries must be single-line. Remove newline characters.`);
    }
    if (search.type === 'lex') {
      const error = validateLexQuery(search.query);
      if (error) {
        throw new Error(`${location} (lex): ${error}`);
      }
    } else if (search.type === 'vec' || search.type === 'hyde') {
      const error = validateSemanticQuery(search.query);
      if (error) {
        throw new Error(`${location} (${search.type}): ${error}`);
      }
    }
  }

  const rankedLists: RankedResult[][] = [];
  const rankedListMeta: RankedListMeta[] = [];
  const docidMap = new Map<string, string>();
  const hasVectors = store.vecAvailable;

  const collectionList = collections ?? [undefined];

  // Step 1: Run FTS for all lex searches (sync, instant)
  for (const search of searches) {
    if (search.type === 'lex') {
      for (const coll of collectionList) {
        const ftsResults = store.searchFTS(search.query, 20, coll);
        if (ftsResults.length > 0) {
          for (const r of ftsResults) docidMap.set(r.filepath, r.docid);
          rankedLists.push(ftsResults.map(r => ({
            file: r.filepath, displayPath: r.displayPath,
            title: r.title, body: r.body || "", score: r.score,
          })));
          rankedListMeta.push({
            source: "fts",
            queryType: "lex",
            query: search.query,
          });
        }
      }
    }
  }

  // Step 2: Batch embed and run vector searches for vec/hyde
  if (hasVectors) {
    const vecSearches = searches.filter(
      (s): s is ExpandedQuery & { type: 'vec' | 'hyde' } =>
        s.type === 'vec' || s.type === 'hyde'
    );
    if (vecSearches.length > 0) {
      const llm = getLlm(store);
      const textsToEmbed = vecSearches.map(s => formatQueryForEmbedding(s.query));
      hooks?.onEmbedStart?.(textsToEmbed.length);
      const embedStart = Date.now();
      const embeddings = await llm.embedBatch(textsToEmbed);
      hooks?.onEmbedDone?.(Date.now() - embedStart);

      for (let i = 0; i < vecSearches.length; i++) {
        const embedding = embeddings[i]?.embedding;
        if (!embedding) continue;

        for (const coll of collectionList) {
          const vecResults = await store.searchVec(
            vecSearches[i]!.query, DEFAULT_EMBED_MODEL, 20, coll,
            undefined, embedding
          );
          if (vecResults.length > 0) {
            for (const r of vecResults) docidMap.set(r.filepath, r.docid);
            rankedLists.push(vecResults.map(r => ({
              file: r.filepath, displayPath: r.displayPath,
              title: r.title, body: r.body || "", score: r.score,
            })));
            rankedListMeta.push({
              source: "vec",
              queryType: vecSearches[i]!.type,
              query: vecSearches[i]!.query,
            });
          }
        }
      }
    }
  }

  if (rankedLists.length === 0) return [];

  // Step 3: RRF fusion — first list gets 2x weight (assume caller ordered by importance)
  const weights = rankedLists.map((_, i) => i === 0 ? 2.0 : 1.0);
  const fused = reciprocalRankFusion(rankedLists, weights);
  const rrfTraceByFile = explain ? buildRrfTrace(rankedLists, weights, rankedListMeta) : null;
  const candidates = fused.slice(0, candidateLimit);

  if (candidates.length === 0) return [];

  hooks?.onExpand?.("", [], 0); // Signal no expansion (pre-expanded)

  // Step 4: Chunk documents, pick best chunk per doc for reranking
  const primaryQuery = searches.find(s => s.type === 'lex')?.query
    || searches.find(s => s.type === 'vec')?.query
    || searches[0]?.query || "";
  const queryTerms = primaryQuery.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const intentTerms = intent ? extractIntentTerms(intent) : [];
  const docChunkMap = chunkAndSelectBest(candidates, queryTerms, intentTerms);

  const ctx: ScoringContext = {
    store, candidates, docChunkMap, docidMap,
    rrfTraceByFile, candidateLimit, explain, minScore, limit,
  };

  if (skipRerank) return buildSkipRerankResults(ctx);

  return buildRerankResults(ctx, primaryQuery, intent, hooks);
}
