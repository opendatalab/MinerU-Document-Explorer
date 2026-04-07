import type { DocumentBackend, TocSection, GrepMatch, QueryChunk, ContentSection, ContentElement } from "./types.js";
import type { Store } from "../store.js";
import { BackendDb, err, Address, Content, Grep as SharedGrep } from "./shared.js";
import { queryWithEmbeddings, createGrepFallback } from "./query-utils.js";

/**
 * Markdown DocumentBackend — reference implementation.
 * Reads content from SQLite (content table), not directly from filesystem.
 */
export function createMarkdownBackend(store: Store): DocumentBackend {
  const db = store.db;
  const backendDb = new BackendDb(db);

  return {
    format: "md",

    async getToc(filepath: string, docid: string): Promise<TocSection[]> {
      const hash = backendDb.getHashByDocid(docid);
      if (!hash) return [];

      const body = backendDb.getBody(hash);
      if (!body) return [];

      const lines = body.split("\n");
      const headingRe = /^(#{1,6})\s+(.+)$/;

      interface HeadingInfo {
        level: number;
        title: string;
        lineStart: number;
        lineEnd: number;
        children: HeadingInfo[];
      }

      const headings: HeadingInfo[] = [];
      for (let i = 0; i < lines.length; i++) {
        const m = headingRe.exec(lines[i]!);
        if (m) {
          headings.push({
            level: m[1]!.length,
            title: m[2]!.trim(),
            lineStart: i + 1,
            lineEnd: lines.length,
            children: [],
          });
        }
      }

      // Set lineEnd for each heading
      for (let i = 0; i < headings.length - 1; i++) {
        headings[i]!.lineEnd = headings[i + 1]!.lineStart - 1;
      }

      function toSection(h: HeadingInfo): TocSection {
        return {
          title: h.title,
          level: h.level,
          address: `line:${h.lineStart}-${h.lineEnd}`,
          children: h.children.map(toSection),
        };
      }

      // Nest headings into tree
      const roots: HeadingInfo[] = [];
      const stack: HeadingInfo[] = [];
      for (const h of headings) {
        while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) {
          stack.pop();
        }
        if (stack.length === 0) {
          roots.push(h);
        } else {
          stack[stack.length - 1]!.children.push(h);
        }
        stack.push(h);
      }

      return roots.map(toSection);
    },

    async readContent(filepath: string, docid: string, addresses: string[], maxTokens = 2000): Promise<ContentSection[]> {
      const { hash, body: doc } = backendDb.getHashAndBody(docid);
      const lines = doc.split("\n");
      const results: ContentSection[] = [];

      for (const address of addresses) {
        const lineRange = Address.parseLine(address);
        if (!lineRange) {
          results.push(Content.section(address, err("INVALID_ADDRESS").message, maxTokens));
          continue;
        }

        const { from, to } = lineRange;
        const fromLine = from - 1; // convert from 1-indexed to 0-indexed
        const toLine = (to ?? lines.length) - 1;
        const sectionLines = lines.slice(fromLine, toLine + 1);
        const text = sectionLines.join("\n");

        const headingM = sectionLines[0]?.match(/^#{1,6}\s+(.+)$/);
        const title = headingM?.[1];

        results.push(Content.section(address, text, maxTokens, { title }));
      }

      return results;
    },

    async grep(filepath: string, docid: string, pattern: string, flags = "gi"): Promise<GrepMatch[]> {
      const { hash, body: doc } = backendDb.getHashAndBody(docid);
      const lines = doc.split("\n");
      const re = SharedGrep.createRegex(pattern, flags);
      const matches: GrepMatch[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        let found: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((found = re.exec(line)) !== null) {
          const contextStart = Math.max(0, i - 3);
          const contextEnd = Math.min(lines.length - 1, i + 3);
          const content = lines.slice(contextStart, contextEnd + 1).join("\n");

          matches.push({
            address: `line:${i + 1}`,
            content,
            match: found[0],
            location: { line: i + 1 },
          });
        }
      }

      return matches;
    },

    async query(filepath: string, docid: string, queryText: string, topK = 5): Promise<QueryChunk[]> {
      const { hash, body: doc } = backendDb.getHashAndBody(docid);

      const chunkRows = db.prepare(
        "SELECT seq, pos FROM content_vectors WHERE hash = ? ORDER BY seq"
      ).all(hash) as { seq: number; pos: number }[];

      if (chunkRows.length === 0) {
        // AC12: no embeddings — fall back to grep with query terms as pattern
        return createGrepFallback(this, filepath, docid, queryText, topK)();
      }

      // Build char-offset to line-number mapping
      const lineOffsets: number[] = [0];
      for (let i = 0; i < doc.length; i++) {
        if (doc[i] === "\n") lineOffsets.push(i + 1);
      }

      function charOffsetToLine(pos: number): number {
        let lo = 0, hi = lineOffsets.length - 1;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          if (lineOffsets[mid]! <= pos) lo = mid;
          else hi = mid - 1;
        }
        return lo + 1;
      }

      // Use the shared queryWithEmbeddings utility
      return queryWithEmbeddings(
        store, hash, doc, queryText, topK,
        (pos) => {
          const lineNum = charOffsetToLine(pos);
          // Estimate end line based on typical chunk size
          const endLine = charOffsetToLine(Math.min(pos + 3600, doc.length - 1));
          return {
            address: `line:${lineNum}-${endLine}`,
            location: { line_range: [lineNum, endLine] as [number, number] },
          };
        },
        createGrepFallback(this, filepath, docid, queryText, topK),
      );
    },

    async extractElements(
      _filepath: string,
      _docid: string,
      _addresses?: string[],
      _query?: string,
      elementTypes?: ("table" | "figure" | "equation")[]
    ): Promise<ContentElement[]> {
      // Markdown documents don't have structured elements extraction.
      // Tables in markdown are part of the text content.
      // This is a stub for API consistency.
      if (elementTypes && elementTypes.length > 0) {
        return [];
      }
      return [];
    },
  };
}
