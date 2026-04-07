/**
 * Shared utilities for document backend query implementations.
 * Provides embedding-based search with LLM reranking and grep fallback.
 */

import type { Store } from "../store.js";
import type { DocumentBackend, QueryChunk } from "./types.js";

type LocationMap = Record<string, number> | { line_range: [number, number] };

/**
 * Create a grep fallback function for when embeddings are not available.
 * This is used by all backends when no vector embeddings exist for a document.
 */
export function createGrepFallback(
  backend: DocumentBackend,
  filepath: string,
  docid: string,
  queryText: string,
  topK: number
): () => Promise<QueryChunk[]> {
  return async () => {
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = queryText.split(/\s+/).slice(0, 3).map(escapeRegex).join("|");
    const grepResults = await backend.grep(filepath, docid, pattern, "gi");
    return grepResults.slice(0, topK).map(m => ({
      address: m.address,
      score: 0,
      text: m.content,
      location: m.location,
    }));
  };
}

/**
 * Shared embedding-based query logic for all document backends.
 *
 * Looks up chunk rows from content_vectors, fetches embeddings in a single
 * batched query (avoiding N+1), embeds the query text, scores by cosine
 * similarity, slices body text, and attempts reranking.
 *
 * @param store - The QMD store instance
 * @param hash - Document content hash
 * @param body - Full document body text
 * @param queryText - The query string
 * @param topK - Number of results to return
 * @param posToAddressAndLocation - Backend-specific mapping from chunk char
 *   offset to address string and location record.
 * @param grepFallback - Called when no embeddings exist (AC12 fallback).
 */
export async function queryWithEmbeddings(
  store: Store,
  hash: string,
  body: string,
  queryText: string,
  topK: number,
  posToAddressAndLocation: (pos: number) => { address: string; location: LocationMap },
  grepFallback: () => Promise<QueryChunk[]>,
): Promise<QueryChunk[]> {
  const db = store.db;

  const chunkRows = db.prepare(
    "SELECT seq, pos FROM content_vectors WHERE hash = ? ORDER BY seq",
  ).all(hash) as { seq: number; pos: number }[];

  if (chunkRows.length === 0) {
    return grepFallback();
  }

  // Batch fetch all embeddings in one query (fixes N+1)
  const hashSeqKeys = chunkRows.map(c => hash + "_" + c.seq);
  const placeholders = hashSeqKeys.map(() => "?").join(",");
  type VecRow = { hash_seq: string; embedding: Float32Array | Buffer };
  const vecRows = db.prepare(
    `SELECT hash_seq, embedding FROM vectors_vec WHERE hash_seq IN (${placeholders})`,
  ).all(...hashSeqKeys) as VecRow[];

  const vecMap = new Map<string, number[]>();
  for (const vecRow of vecRows) {
    if (vecRow.embedding) {
      let emb: number[];
      if (vecRow.embedding instanceof Buffer || ArrayBuffer.isView(vecRow.embedding)) {
        const buf = vecRow.embedding instanceof Buffer
          ? vecRow.embedding.buffer.slice(vecRow.embedding.byteOffset, vecRow.embedding.byteOffset + vecRow.embedding.byteLength)
          : (vecRow.embedding as ArrayBufferView).buffer;
        const f32 = new Float32Array(buf);
        emb = Array.from(f32);
      } else {
        emb = vecRow.embedding as unknown as number[];
      }
      vecMap.set(vecRow.hash_seq, emb);
    }
  }

  const chunkEmbeddings: Array<{ seq: number; pos: number; embedding: number[] }> = [];
  for (const chunk of chunkRows) {
    const emb = vecMap.get(hash + "_" + chunk.seq);
    if (emb) {
      chunkEmbeddings.push({ seq: chunk.seq, pos: chunk.pos, embedding: emb });
    }
  }

  if (chunkEmbeddings.length === 0) {
    return grepFallback();
  }

  // Store.llm is set by the SDK layer (index.ts) when creating the store
  const llm = store.llm;
  if (!llm) {
    throw new Error("LLM not available for query. Ensure embeddings are configured.");
  }

  let queryEmbedding: number[];
  try {
    const { withLLMSessionForLlm, formatQueryForEmbedding } = await import("../llm.js");
    const result = await withLLMSessionForLlm(llm, async (session: any) => {
      return session.embed(formatQueryForEmbedding(queryText));
    });
    if (!result) throw new Error("embed returned null");
    queryEmbedding = result.embedding;
  } catch {
    throw new Error("Failed to embed query. Ensure the embedding model is configured.");
  }

  function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      na += a[i]! * a[i]!;
      nb += b[i]! * b[i]!;
    }
    return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  const scored = chunkEmbeddings.map(c => ({
    ...c,
    score: cosine(queryEmbedding, c.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, Math.min(topK * 3, scored.length));

  const chunkSize = 3600;
  const candidatesWithText = candidates.map(c => ({
    ...c,
    text: body.slice(c.pos, c.pos + chunkSize),
  }));

  // Attempt reranking
  let finalCandidates = candidatesWithText;
  try {
    const rerankDocs = candidatesWithText.map(c => ({ file: String(c.seq), text: c.text }));
    const rerankResults = await store.rerank(queryText, rerankDocs);
    const seqToScore = new Map(rerankResults.map(r => [r.file, r.score]));
    finalCandidates = candidatesWithText.map(c => ({
      ...c,
      score: seqToScore.get(String(c.seq)) ?? c.score,
    }));
    finalCandidates.sort((a, b) => b.score - a.score);
  } catch {
    // Reranker not available, use cosine scores
  }

  return finalCandidates.slice(0, topK).map(c => {
    const { address, location } = posToAddressAndLocation(c.pos);
    return {
      address,
      score: Math.round(c.score * 100) / 100,
      text: c.text,
      location,
    };
  });
}
