import type { DocumentBackend, TocSection, GrepMatch, QueryChunk, ContentSection } from "./types.js";
import type { Store } from "../store.js";
import { extractPdf, extractPdfPageindex } from "./python-utils.js";
import { queryWithEmbeddings, createGrepFallback } from "./query-utils.js";
import { getProviders, getMinerUCredentials, getOpenAICredentials } from "../doc-reading-config.js";
import { BackendDb, err, Address, Content, Grep as SharedGrep } from "./shared.js";

/**
 * PDF DocumentBackend — reads page content from pages_cache / toc_cache in SQLite.
 * PyMuPDF extraction is used for TOC (bookmarks) when not yet cached.
 */
export function createPdfBackend(store: Store): DocumentBackend {
  const db = store.db;
  const backendDb = new BackendDb(db);

  function bookmarksToTree(bookmarks: { level: number; title: string; page: number }[]): TocSection[] {
    const roots: TocSection[] = [];
    const stack: TocSection[] = [];
    for (const bm of bookmarks) {
      const node: TocSection = {
        title: bm.title,
        level: bm.level,
        address: `pages:${bm.page}`,
        children: [],
      };
      while (stack.length > 0 && stack[stack.length - 1]!.level >= bm.level) stack.pop();
      if (stack.length === 0) roots.push(node);
      else stack[stack.length - 1]!.children.push(node);
      stack.push(node);
    }
    return roots;
  }

  /** Convert PageIndex tree structure to QMD TocSection[]. PageIndex uses 1-indexed pages. */
  function pageIndexTreeToToc(nodes: any[], level = 1): TocSection[] {
    if (!Array.isArray(nodes)) return [];
    return nodes.map(node => ({
      title: node.title ?? "Untitled",
      level,
      address: node.start_index != null ? `pages:${node.start_index - 1}` : "pages:0",
      children: pageIndexTreeToToc(node.nodes ?? [], level + 1),
    }));
  }

  return {
    format: "pdf",

    async getToc(filepath: string, docid: string): Promise<TocSection[]> {
      // Return from cache if available (any source)
      const cached = db.prepare(
        "SELECT sections, source FROM toc_cache WHERE docid = ?"
      ).get(docid) as { sections: string; source: string } | undefined;
      if (cached) {
        try { return JSON.parse(cached.sections) as TocSection[]; }
        catch { db.prepare("DELETE FROM toc_cache WHERE docid = ?").run(docid); }
      }

      // Try toc providers in priority order
      const tocProviders = getProviders("toc", "pdf");

      for (const provider of tocProviders) {
        if (provider === "native_bookmarks") {
          // Extract bookmarks via PyMuPDF (always available, local)
          let pdfData: Awaited<ReturnType<typeof extractPdf>>;
          try { pdfData = await extractPdf(filepath); } catch { continue; }
          if (pdfData.error) continue;

          const bookmarks = pdfData.bookmarks ?? [];
          if (bookmarks.length === 0) continue; // no bookmarks, try next provider

          const tree = bookmarksToTree(bookmarks);
          db.prepare(
            "INSERT OR REPLACE INTO toc_cache (docid, sections, source, created_at) VALUES (?, ?, ?, ?)"
          ).run(docid, JSON.stringify(tree), "native_bookmarks", Date.now());
          return tree;

        } else if (provider === "gpt_pageindex") {
          // GPT PageIndex: LLM-inferred TOC via OpenAI-compatible API + Explorer PageIndex script
          const openaiCreds = getOpenAICredentials();
          if (!openaiCreds) continue;

          let piData: Awaited<ReturnType<typeof extractPdfPageindex>>;
          try {
            piData = await extractPdfPageindex(filepath, openaiCreds.base_url, openaiCreds.model);
          } catch { continue; }
          if (piData.error) continue;

          const structure = piData.structure ?? [];
          const tree = pageIndexTreeToToc(Array.isArray(structure) ? structure : [structure]);
          if (tree.length === 0) continue;

          db.prepare(
            "INSERT OR REPLACE INTO toc_cache (docid, sections, source, created_at) VALUES (?, ?, ?, ?)"
          ).run(docid, JSON.stringify(tree), "gpt_pageindex", Date.now());
          return tree;

        } else if (provider === "mineru_pageindex") {
          // 🚧 Placeholder: MinerU PageIndex (LLM-inferred TOC) — not yet available
          // When mineru-open-sdk adds PageIndex support, implement here.
          // For now, check credentials exist so we can inform the user.
          const creds = getMinerUCredentials();
          if (!creds) continue;
          // Fall through: mineru_pageindex not yet implemented
          continue;
        }
      }

      return []; // No provider produced a TOC
    },

    async readContent(filepath: string, docid: string, addresses: string[], maxTokens = 2000): Promise<ContentSection[]> {
      const results: ContentSection[] = [];

      for (const address of addresses) {
        const pageRange = Address.parsePages(address);
        if (!pageRange) {
          results.push(Content.section(address, err("INVALID_ADDRESS").message, maxTokens));
          continue;
        }

        const { from, to } = pageRange;
        const rows = db.prepare(
          "SELECT page_idx, text, source FROM pages_cache WHERE docid = ? AND page_idx >= ? AND page_idx <= ? ORDER BY page_idx"
        ).all(docid, from, to) as { page_idx: number; text: string; source: string }[];

        if (rows.length === 0) {
          results.push({
            address,
            text: "PDF not indexed with page cache. Re-index with 'qmd update' or configure MinerU.",
            num_tokens: 0,
          });
          continue;
        }

        const text = rows.map(r => r.text).join("\n\n---\n\n");
        const source = rows[0]!.source;
        results.push(Content.section(address, text, maxTokens, { source }));
      }

      return results;
    },

    async grep(filepath: string, docid: string, pattern: string, flags = "gi"): Promise<GrepMatch[]> {
      const rows = db.prepare(
        "SELECT page_idx, text FROM pages_cache WHERE docid = ? ORDER BY page_idx"
      ).all(docid) as { page_idx: number; text: string }[];

      if (rows.length === 0) return [];

      const re = SharedGrep.createRegex(pattern, flags);
      const matches: GrepMatch[] = [];

      for (const row of rows) {
        let found: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((found = re.exec(row.text)) !== null) {
          const content = SharedGrep.extractContext(row.text, found.index, found[0].length, 250);
          matches.push({
            address: `pages:${row.page_idx}`,
            content,
            match: found[0],
            location: { page_idx: row.page_idx },
          });
        }
      }

      return matches;
    },

    async query(filepath: string, docid: string, queryText: string, topK = 5): Promise<QueryChunk[]> {
      const { hash, body } = backendDb.getHashAndBody(docid);

      // Get all pages for page_idx mapping
      const pageRows = db.prepare(
        "SELECT page_idx, text FROM pages_cache WHERE docid = ? ORDER BY page_idx"
      ).all(docid) as { page_idx: number; text: string }[];

      // Build cumulative char offsets per page (pages joined with "\n\n")
      const pageOffsets: number[] = [];
      let offset = 0;
      for (const page of pageRows) {
        pageOffsets.push(offset);
        offset += page.text.length + 2; // +2 for "\n\n" separator
      }

      function posToPageIdx(pos: number): number {
        let lo = 0, hi = pageOffsets.length - 1;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          if (pageOffsets[mid]! <= pos) lo = mid;
          else hi = mid - 1;
        }
        return pageRows[lo]?.page_idx ?? 0;
      }

      return queryWithEmbeddings(
        store, hash, body, queryText, topK,
        (pos) => {
          const pageIdx = pageRows.length > 0 ? posToPageIdx(pos) : 0;
          return { address: `pages:${pageIdx}`, location: { page_idx: pageIdx } };
        },
        createGrepFallback(this, filepath, docid, queryText, topK),
      );
    },

    async extractElements(_filepath, _docid, _addresses, _query, _elementTypes) {
      throw err("NOT_CONFIGURED", "doc_elements for PDF requires cloud configuration (not yet available)");
    },
  };
}
