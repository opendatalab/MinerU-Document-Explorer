import type { DocumentBackend, TocSection, GrepMatch, QueryChunk, ContentSection, ContentElement } from "./types.js";
import type { Store } from "../store.js";
import { extractDocxTables } from "./python-utils.js";
import { queryWithEmbeddings, createGrepFallback } from "./query-utils.js";
import { BackendDb, err, Address, Content, Grep as SharedGrep } from "./shared.js";

interface SectionMapRow {
  section_idx: number;
  heading: string | null;
  level: number | null;
  line_start: number;
  line_end: number;
}

/**
 * Docx DocumentBackend.
 * Reads from section_map table (populated during indexing) and content table.
 */
export function createDocxBackend(store: Store): DocumentBackend {
  const db = store.db;
  const backendDb = new BackendDb(db);

  function getSections(docid: string): SectionMapRow[] {
    return db.prepare(
      "SELECT section_idx, heading, level, line_start, line_end FROM section_map WHERE docid = ? ORDER BY section_idx"
    ).all(docid) as SectionMapRow[];
  }

  function charOffsetToSection(body: string, sections: SectionMapRow[], pos: number): number {
    if (sections.length === 0) return 0;
    const bodyLines = body.split("\n");
    let charCount = 0;
    let lineNum = 1;
    for (let i = 0; i < bodyLines.length; i++) {
      const lineEnd = charCount + bodyLines[i]!.length + 1;
      if (pos < lineEnd) { lineNum = i + 1; break; }
      charCount = lineEnd;
    }
    for (const s of sections) {
      if (lineNum >= s.line_start && lineNum <= s.line_end) return s.section_idx;
    }
    return sections[sections.length - 1]!.section_idx;
  }

  const backend: DocumentBackend = {
    format: "docx",

    async getToc(filepath: string, docid: string): Promise<TocSection[]> {
      const sections = getSections(docid);
      if (sections.length === 0) return [];

      interface NodeInfo extends TocSection {
        _level: number;
      }

      const nodes: NodeInfo[] = sections.map(s => ({
        title: s.heading || "(untitled)",
        level: s.level || 1,
        address: `section:${s.section_idx}`,
        children: [],
        _level: s.level || 1,
      }));

      const roots: NodeInfo[] = [];
      const stack: NodeInfo[] = [];

      for (const node of nodes) {
        while (stack.length > 0 && stack[stack.length - 1]!._level >= node._level) {
          stack.pop();
        }
        if (stack.length === 0) {
          roots.push(node);
        } else {
          stack[stack.length - 1]!.children.push(node);
        }
        stack.push(node);
      }

      function stripLevel(n: NodeInfo): TocSection {
        return {
          title: n.title,
          level: n.level,
          address: n.address,
          children: n.children.map(c => stripLevel(c as NodeInfo)),
        };
      }

      return roots.map(stripLevel);
    },

    async readContent(filepath: string, docid: string, addresses: string[], maxTokens = 2000): Promise<ContentSection[]> {
      const { hash } = backendDb.getHashAndBody(docid);
      const body = backendDb.getBody(hash)!;
      const lines = body.split("\n");
      const sections = getSections(docid);
      const sectionByIdx = new Map(sections.map(s => [s.section_idx, s]));

      const results: ContentSection[] = [];

      for (const address of addresses) {
        const sectionIdx = Address.parseSection(address);
        if (sectionIdx === null) {
          results.push(Content.section(address, err("INVALID_ADDRESS").message, maxTokens));
          continue;
        }

        const section = sectionByIdx.get(sectionIdx);
        if (!section) {
          results.push(Content.section(address, err("SECTION_NOT_FOUND", undefined, { sectionIdx }).message, maxTokens));
          continue;
        }

        const fromLine = section.line_start - 1;
        const toLine = section.line_end - 1;
        const sectionLines = lines.slice(fromLine, toLine + 1);
        const text = sectionLines.join("\n");
        const title = section.heading || undefined;

        results.push(Content.section(address, text, maxTokens, { title }));
      }

      return results;
    },

    async grep(filepath: string, docid: string, pattern: string, flags = "gi"): Promise<GrepMatch[]> {
      const { hash } = backendDb.getHashAndBody(docid);
      const body = backendDb.getBody(hash)!;
      const sections = getSections(docid);
      const lines = body.split("\n");

      const re = SharedGrep.createRegex(pattern, flags);

      // Build line → section_idx mapping (1-indexed)
      const lineToSection = new Map<number, number>();
      for (const s of sections) {
        for (let ln = s.line_start; ln <= s.line_end; ln++) {
          lineToSection.set(ln, s.section_idx);
        }
      }

      const matches: GrepMatch[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        let found: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((found = re.exec(line)) !== null) {
          const lineNum = i + 1;
          const contextStart = Math.max(0, i - 3);
          const contextLines = lines.slice(contextStart, i + 4);
          const contextStr = contextLines.join("\n");
          const linesBeforeInContext = i - contextStart;
          const offsetInContext = contextLines.slice(0, linesBeforeInContext).join("\n").length
            + (linesBeforeInContext > 0 ? 1 : 0) + found.index;
          const content = SharedGrep.extractContext(contextStr, offsetInContext, found[0].length, 200);
          const section_idx = lineToSection.get(lineNum) ?? 0;

          matches.push({
            address: `section:${section_idx}`,
            content,
            match: found[0],
            location: { section_idx },
          });
        }
      }

      return matches;
    },

    async query(filepath: string, docid: string, queryText: string, topK = 5): Promise<QueryChunk[]> {
      const { hash, body } = backendDb.getHashAndBody(docid);
      const sections = getSections(docid);

      return queryWithEmbeddings(
        store, hash, body, queryText, topK,
        (pos) => {
          const sectionIdx = charOffsetToSection(body, sections, pos);
          return { address: `section:${sectionIdx}`, location: { section_idx: sectionIdx } };
        },
        createGrepFallback(backend, filepath, docid, queryText, topK),
      );
    },

    async extractElements(
      filepath: string,
      docid: string,
      addresses?: string[],
      _query?: string,
      elementTypes?: ("table" | "figure" | "equation")[]
    ): Promise<ContentElement[]> {
      if (elementTypes && elementTypes.length > 0 && !elementTypes.includes("table")) {
        return [];
      }

      let result: Awaited<ReturnType<typeof extractDocxTables>>;
      try {
        result = await extractDocxTables(filepath);
      } catch (e: any) {
        throw err("EXTRACTION_FAILED", `extractElements failed for docx: ${e.message}`);
      }

      if (result.error) {
        throw err("EXTRACTION_FAILED", `Python script error: ${result.error}`);
      }

      let tables = result.tables ?? [];

      if (addresses && addresses.length > 0) {
        const requestedSections = new Set(
          addresses
            .map(a => Address.parseSection(a))
            .filter((x): x is number => x !== null)
        );
        tables = tables.filter(t => requestedSections.has(t.section_idx));
      }

      return tables.map(t => ({
        address: `section:${t.section_idx}`,
        element_type: "table" as const,
        content: t.html,
      }));
    },
  };
  return backend;
}
