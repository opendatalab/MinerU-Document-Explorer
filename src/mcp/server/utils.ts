/**
 * MCP Server utilities — instructions builder, helpers.
 */

import type { QMDStore } from "../../index.js";

/**
 * Build dynamic server instructions from actual index state.
 * Injected into the LLM's system prompt via MCP initialize response.
 */
export async function buildInstructions(store: QMDStore): Promise<string> {
  const status = await store.getStatus();
  const contexts = await store.listContexts();
  const globalCtx = await store.getGlobalContext();
  const collections = await store.listCollections();
  const lines: string[] = [];

  // --- What is this? ---
  lines.push(`MinerU Document Explorer — agent-native knowledge engine with ${status.totalDocuments} indexed documents.`);
  lines.push(`Hybrid search: BM25 keywords + vector semantics + LLM reranking. Supports Markdown, PDF, DOCX, PPTX.`);
  if (globalCtx) lines.push(`Context: ${globalCtx}`);

  // --- What's searchable? ---
  const rawCollections = collections.filter(c => c.type !== "wiki");
  const wikiCollections = collections.filter(c => c.type === "wiki");

  if (rawCollections.length > 0) {
    lines.push("");
    lines.push("Source collections (raw, read-only):");
    for (const col of rawCollections) {
      const rootCtx = contexts.find(c => c.collection === col.name && (c.path === "" || c.path === "/"));
      const desc = rootCtx ? ` — ${rootCtx.context}` : "";
      lines.push(`  - "${col.name}" (${col.active_count} docs)${desc}`);
    }
  }

  if (wikiCollections.length > 0) {
    lines.push("");
    lines.push("Wiki collections (LLM-maintained, read-write):");
    for (const col of wikiCollections) {
      const rootCtx = contexts.find(c => c.collection === col.name && (c.path === "" || c.path === "/"));
      const desc = rootCtx ? ` — ${rootCtx.context}` : "";
      lines.push(`  - "${col.name}" (${col.active_count} pages)${desc}`);
    }
  }

  if (collections.length === 0) {
    lines.push("");
    lines.push("No collections configured yet. Ask the user to index their documents first:");
    lines.push("  qmd collection add ~/path/to/docs --name myname");
    lines.push("  qmd embed  # optional: enables semantic search");
    lines.push("Then restart the MCP server to pick up the new index.");
  }

  // --- Capability gaps ---
  if (!status.hasVectorIndex) {
    lines.push("");
    lines.push("Note: No vector embeddings yet. Run `qmd embed` to enable semantic search (vec/hyde).");
  } else if (status.needsEmbedding > 0) {
    lines.push("");
    lines.push(`Note: ${status.needsEmbedding} documents need embedding. Run \`qmd embed\` to update.`);
  }

  // --- Three tool groups ---
  lines.push("");
  lines.push("Tools are organized in three groups:");
  lines.push("");

  // --- Group 1: Retrieval ---
  lines.push("1. RETRIEVAL — find and fetch documents:");
  lines.push("  - `query` — hybrid search. Two modes:");
  lines.push("      Simple (recommended): query='your search terms' — auto-expands into BM25 + semantic + reranking.");
  lines.push("      Advanced: searches=[{type:'lex|vec|hyde', query:'...'}] — manual control.");
  lines.push("      Add `intent` to disambiguate ambiguous queries.");
  lines.push("  - `get` — single document by path or docid (#abc123). Supports line offset (file.md:100).");
  lines.push("  - `multi_get` — batch retrieve by glob (journals/2025-05*.md), comma-separated list, or comma-separated globs (docs/api*.md, docs/config*.md).");
  lines.push("  - `status` — index health, collections, document counts.");

  // --- Group 2: Deep Reading ---
  lines.push("");
  lines.push("2. DEEP READING — navigate and search within a single document:");
  lines.push("  - `doc_toc` — table of contents (headings/bookmarks/slides). Start here for large docs.");
  lines.push("  - `doc_read` — read content at addresses from doc_toc/doc_grep/doc_query.");
  lines.push("  - `doc_grep` — regex/keyword search within one document. Returns addresses for doc_read.");
  lines.push("  - `doc_query` — semantic search within one document. Requires embeddings.");
  lines.push("  - `doc_elements` — extract tables, figures, equations.");
  lines.push("  - `doc_links` — forward/backward link graph for a document.");
  lines.push("  Workflow: doc_toc → pick addresses → doc_read → synthesize.");
  lines.push("  Addresses are strings like 'line:45-120' (Markdown), 'page:3' (PDF), 'slide:5' (PPTX).");
  lines.push("  Get addresses from doc_toc/doc_grep/doc_query, then pass them to doc_read.");

  // --- Group 3: Knowledge Ingestion ---
  if (wikiCollections.length > 0 || rawCollections.length > 0) {
    lines.push("");
    lines.push("3. KNOWLEDGE INGESTION — build and maintain a wiki knowledge base:");
    lines.push("  - `wiki_ingest` — prepare a source document (MD/PDF/DOCX/PPTX). Incremental: skips unchanged.");
    lines.push("  - `doc_write` — write wiki pages (auto-logged). Pass `source` for provenance tracking.");
    lines.push("  - `wiki_lint` — health-check: orphans, broken links, stale pages.");
    lines.push("  - `wiki_log` — activity timeline.");
    lines.push("  - `wiki_index` — generate/update the wiki index page.");
    lines.push("  Workflow: wiki_ingest → doc_read (key sections) → doc_write (with source) → wiki_lint.");
  }

  // --- Group 4: Web Tools ---
  lines.push("");
  lines.push("4. WEB TOOLS — search the live web, score source credibility, verify claims:");
  lines.push("  - `web_search(query, results, ...)` — bridge for CC native WebSearch output. Call your built-in WebSearch first, then pass the markdown blob here for normalization into structured results. Omitting `results` returns an `isError` hint to call WebSearch first.");
  lines.push("  - `web_fetch(url, ...)` — fetch a single URL and convert to Markdown (title + meta + extracted links). Results can be written to a `web` collection for downstream `wiki_ingest`.");
  lines.push("  - `credibility_score(url, snippet?, ...)` — heuristic credibility scoring (0–1) with domain / recency / corroboration sub-scores. Use to filter `web_fetch` candidates before ingestion. `method=\"judge\"` blends heuristic with an agent-supplied judge verdict.");
  lines.push("  - `judge_claim(source_text, claim, verdict?, reasoning?, confidence?)` — write-back LLM-judge. Agent reasons about whether a claim is verified/under_supported/contradicted/gaming, then calls this tool to record the verdict. Omitting `verdict` returns a `JUDGE_INPUT_REQUIRED` hint.");
  lines.push("  Workflow: web_search → credibility_score (filter) → web_fetch → judge_claim (verify claims before ingest) → wiki_ingest.");

  // --- Quick workflow ---
  lines.push("");
  lines.push("Typical workflow:");
  lines.push("  1. `query` to find relevant documents");
  lines.push("  2. `get` to read a document (by path or #docid from search results)");
  lines.push("  3. For large docs: `doc_toc` → `doc_read` to navigate by section");
  lines.push("  4. For wiki building: `wiki_ingest` → `doc_write` → `wiki_lint`");

  // --- Non-obvious things that prevent mistakes ---
  lines.push("");
  lines.push("Tips:");
  lines.push("  - File paths in results are collection-relative (e.g. 'docs/readme.md').");
  lines.push("  - Use `minScore: 0.5` to filter low-confidence results.");
  lines.push("  - For PDFs and large docs, prefer doc_toc + doc_read over get.");
  lines.push("  - Use doc_links to explore cross-references between documents.");
  lines.push("  - Search results include docid (#abc123) — use it with get or doc_toc.");

  return lines.join("\n");
}
