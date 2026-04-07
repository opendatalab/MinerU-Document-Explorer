import type { DocumentBackend, TocSection, GrepMatch, QueryChunk, ContentSection, ContentElement } from "./types.js";
import type { Store } from "../store.js";
import { extractPptxTables } from "./python-utils.js";
import { queryWithEmbeddings, createGrepFallback } from "./query-utils.js";
import { BackendDb, err, Address, Content, Grep as SharedGrep } from "./shared.js";

interface SlideRow {
  slide_idx: number;
  title: string | null;
  text: string;
  tokens: number | null;
}

/**
 * PPTX DocumentBackend.
 * Reads from slide_cache table (populated during indexing).
 * slide_cache schema: (docid, slide_idx, title, text, tokens)
 */
export function createPptxBackend(store: Store): DocumentBackend {
  const db = store.db;
  const backendDb = new BackendDb(db);

  function getSlides(docid: string): SlideRow[] {
    return db.prepare(
      "SELECT slide_idx, title, text, tokens FROM slide_cache WHERE docid = ? ORDER BY slide_idx"
    ).all(docid) as SlideRow[];
  }

  function charOffsetToSlide(slides: SlideRow[], pos: number): number {
    // Build cumulative char offsets matching how extractPptxForIndex builds the body:
    // slides.map(s => s.text || '').filter(Boolean).join("\n\n")
    // Empty-text slides are excluded from the joined body, so skip them here too.
    const slideOffsets: Array<{ slide_idx: number; start: number; end: number }> = [];
    let offset = 0;
    let first = true;
    for (const slide of slides) {
      if (!slide.text) continue;
      if (!first) offset += 2; // +2 for "\n\n" separator between slides
      first = false;
      const slideLen = slide.text.length;
      slideOffsets.push({ slide_idx: slide.slide_idx, start: offset, end: offset + slideLen });
      offset += slideLen;
    }

    for (const s of slideOffsets) {
      if (pos >= s.start && pos < s.end) return s.slide_idx;
    }
    return slideOffsets.length > 0 ? slideOffsets[slideOffsets.length - 1]!.slide_idx : 0;
  }

  const backend: DocumentBackend = {
    format: "pptx",

    async getToc(filepath: string, docid: string): Promise<TocSection[]> {
      const slides = getSlides(docid);
      return slides.map(s => ({
        title: s.title || `Slide ${s.slide_idx + 1}`,
        level: 1,
        address: `slide:${s.slide_idx}`,
        children: [],
      }));
    },

    async readContent(filepath: string, docid: string, addresses: string[], maxTokens = 2000): Promise<ContentSection[]> {
      const slides = getSlides(docid);
      const slideByIdx = new Map(slides.map(s => [s.slide_idx, s]));

      const results: ContentSection[] = [];

      for (const address of addresses) {
        const slideIdx = Address.parseSlide(address);
        if (slideIdx === null) {
          results.push(Content.section(address, err("INVALID_ADDRESS").message, maxTokens));
          continue;
        }

        const slide = slideByIdx.get(slideIdx);
        if (!slide) {
          results.push(Content.section(address, err("SLIDE_NOT_FOUND", undefined, { slideIdx }).message, maxTokens));
          continue;
        }

        results.push(Content.section(
          address,
          slide.text,
          maxTokens,
          { title: slide.title || undefined }
        ));
      }

      return results;
    },

    async grep(filepath: string, docid: string, pattern: string, flags = "gi"): Promise<GrepMatch[]> {
      const slides = getSlides(docid);
      const re = SharedGrep.createRegex(pattern, flags);
      const matches: GrepMatch[] = [];

      for (const slide of slides) {
        const searchText = [slide.title, slide.text].filter(Boolean).join("\n");
        let found: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((found = re.exec(searchText)) !== null) {
          const content = SharedGrep.extractContext(searchText, found.index, found[0].length, 200);
          matches.push({
            address: `slide:${slide.slide_idx}`,
            content,
            match: found[0],
            location: { slide_idx: slide.slide_idx },
          });
        }
      }

      return matches;
    },

    async query(filepath: string, docid: string, queryText: string, topK = 5): Promise<QueryChunk[]> {
      const { hash, body } = backendDb.getHashAndBody(docid);
      const slides = getSlides(docid);

      return queryWithEmbeddings(
        store, hash, body, queryText, topK,
        (pos) => {
          const slideIdx = charOffsetToSlide(slides, pos);
          return { address: `slide:${slideIdx}`, location: { slide_idx: slideIdx } };
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

      let result: Awaited<ReturnType<typeof extractPptxTables>>;
      try {
        result = await extractPptxTables(filepath);
      } catch (e: any) {
        throw err("EXTRACTION_FAILED", `extractElements failed for pptx: ${e.message}`);
      }

      if (result.error) {
        throw err("EXTRACTION_FAILED", `Python script error: ${result.error}`);
      }

      const tablesData = result.tables ?? [];

      let tables = tablesData;

      if (addresses && addresses.length > 0) {
        const requestedSlides = new Set(
          addresses
            .map(a => Address.parseSlide(a))
            .filter((x): x is number => x !== null)
        );
        tables = tables.filter(t => requestedSlides.has(t.slide_idx));
      }

      const elements: ContentElement[] = [];
      for (const tableEntry of tables) {
        for (const table of tableEntry.tables ?? []) {
          elements.push({
            address: `slide:${tableEntry.slide_idx}`,
            element_type: "table" as const,
            content: table.html,
          });
        }
      }

      return elements;
    },
  };
  return backend;
}
