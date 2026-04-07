/**
 * DocumentBackend types — shared interfaces for multi-format document reading.
 * All formats (md, pdf, docx, pptx) implement DocumentBackend.
 */

/** A node in the document table of contents tree */
export interface TocSection {
  title: string;
  level: number;       // 1=chapter, 2=section, 3=subsection
  address: string;     // format-specific: "line:45-120" | "pages:12-15" | "section:3" | "slide:4"
  children: TocSection[];
}

/** A match from in-document grep */
export interface GrepMatch {
  address: string;     // can be passed directly to readContent()
  content: string;     // surrounding paragraph text
  match: string;       // the specific matched substring
  location?: {
    page_idx?: number;      // PDF (0-indexed)
    section_idx?: number;   // Docx (0-indexed)
    slide_idx?: number;     // PPTX (0-indexed)
    line?: number;          // Markdown (1-indexed)
  };
}

/** A semantically scored chunk from in-document query */
export interface QueryChunk {
  address: string;     // can be passed directly to readContent()
  score: number;       // 0-1 after reranking
  text: string;        // chunk text (the answer content)
  location?: {
    page_idx?: number;
    section_idx?: number;
    slide_idx?: number;
    line_range?: [number, number];  // Markdown (1-indexed)
  };
}

/** A content section returned by readContent */
export interface ContentSection {
  address: string;
  title?: string;
  text: string;
  num_tokens: number;
  truncated?: boolean;     // true if content exceeded max_tokens and was cut
  total_tokens?: number;   // actual token count before truncation
  source?: string;         // PDF only: "mineru" | "pymupdf"
}

/** A structured element (table, figure, equation) from doc_elements */
export interface ContentElement {
  address: string;
  element_type: "table" | "figure" | "equation";
  bbox?: [number, number, number, number];
  content: string;     // table HTML / formula LaTeX / figure description
  crop_path?: string;
}

/**
 * DocumentBackend — unified interface for format-specific document operations.
 * MCP tools dispatch to the appropriate backend based on file extension.
 */
export interface DocumentBackend {
  readonly format: "md" | "pdf" | "docx" | "pptx";
  getToc(filepath: string, docid: string): Promise<TocSection[]>;
  readContent(filepath: string, docid: string, addresses: string[], maxTokens?: number): Promise<ContentSection[]>;
  grep(filepath: string, docid: string, pattern: string, flags?: string): Promise<GrepMatch[]>;
  query(filepath: string, docid: string, queryText: string, topK?: number): Promise<QueryChunk[]>;
  extractElements?(
    filepath: string,
    docid: string,
    addresses?: string[],
    query?: string,
    elementTypes?: ("table" | "figure" | "equation")[]
  ): Promise<ContentElement[]>;
}
