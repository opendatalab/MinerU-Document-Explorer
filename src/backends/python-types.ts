/**
 * TypeScript types for Python script return values.
 * All Python extraction scripts return structured JSON that matches these schemas.
 */

import { z } from "zod";

// =============================================================================
// PDF Extraction Types
// =============================================================================

/**
 * Schema for PDF text extraction results (extract_pdf.py).
 * Used by both PyMuPDF and MinerU extraction.
 */
export const PdfExtractionResultSchema = z.object({
  error: z.string().optional(),
  source: z.enum(["pymupdf", "mineru"]).optional(),
  pages: z.array(z.object({
    page_idx: z.number(),
    text: z.string(),
  })).optional(),
  bookmarks: z.array(z.object({
    level: z.number(),
    title: z.string(),
    page: z.number(),
  })).optional(),
});

export type PdfExtractionResult = z.infer<typeof PdfExtractionResultSchema>;

/**
 * Schema for GPT PageIndex results (extract_pdf_pageindex.py).
 */
export const PageIndexResultSchema = z.object({
  error: z.string().optional(),
  structure: z.array(z.object({
    title: z.string(),
    start_index: z.number(),  // 1-indexed page number
    nodes: z.lazy(() => PageIndexResultSchema),  // recursive
  })).optional(),
});

export type PageIndexResult = z.infer<typeof PageIndexResultSchema>;

// =============================================================================
// Docx Extraction Types
// =============================================================================

/**
 * Schema for Docx text extraction results (extract_docx.py).
 */
export const DocxSectionSchema = z.object({
  section_idx: z.number(),
  heading: z.string().nullable(),
  level: z.number().nullable(),
  line_start: z.number(),
  line_end: z.number(),
  text: z.string().optional(),
});

export const DocxExtractionResultSchema = z.object({
  error: z.string().optional(),
  markdown: z.string().optional(),
  sections: z.array(DocxSectionSchema).optional(),
  tables: z.array(z.object({
    section_idx: z.number(),
    html: z.string(),
  })).optional(),
});

export type DocxExtractionResult = z.infer<typeof DocxExtractionResultSchema>;
export type DocxSection = z.infer<typeof DocxSectionSchema>;

// =============================================================================
// PPTX Extraction Types
// =============================================================================

/**
 * Schema for PPTX slide extraction results (extract_pptx.py).
 */
export const PptxSlideSchema = z.object({
  slide_idx: z.number(),
  title: z.string().nullable(),
  text: z.string(),
  tokens: z.number().nullable(),
  tables: z.array(z.object({ html: z.string() })).optional(),
});

export const PptxExtractionResultSchema = z.object({
  error: z.string().optional(),
  slides: z.array(PptxSlideSchema).optional(),
  tables: z.array(z.object({
    slide_idx: z.number(),
    tables: z.array(z.object({
      html: z.string(),
    })),
  })).optional(),
}).transform(data => {
  // Python script embeds tables per-slide; normalize to top-level `tables` field
  // for backward compatibility with extractPptxTables consumers
  if (!data.tables && data.slides) {
    const slideTables = data.slides
      .filter(s => s.tables && s.tables.length > 0)
      .map(s => ({ slide_idx: s.slide_idx, tables: s.tables! }));
    if (slideTables.length > 0) {
      return { ...data, tables: slideTables };
    }
  }
  return data;
});

export type PptxExtractionResult = z.infer<typeof PptxExtractionResultSchema>;
export type PptxSlide = z.infer<typeof PptxSlideSchema>;

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Parse and validate a Python script result.
 * Throws a detailed error if validation fails.
 */
export function parsePythonResult<T extends z.ZodType>(
  data: unknown,
  schema: T,
  scriptName: string
): z.infer<T> {
  const result = schema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");

    throw new Error(
      `Invalid output from Python script '${scriptName}':\n${errors}`
    );
  }

  return result.data;
}

/**
 * Check if a Python result contains an error.
 * Returns the error message or null.
 */
export function getPythonError(data: unknown): string | null {
  if (typeof data === "object" && data !== null && "error" in data) {
    const error = (data as { error?: string }).error;
    return typeof error === "string" ? error : null;
  }
  return null;
}
