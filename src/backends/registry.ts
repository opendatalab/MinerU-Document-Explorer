import type { DocumentBackend } from "./types.js";
import type { Store } from "../store.js";

const EXTENSION_MAP: Record<string, DocumentBackend["format"]> = {
  ".md": "md",
  ".markdown": "md",
  ".mdx": "md",
  ".pdf": "pdf",
  ".doc": "docx",
  ".docx": "docx",
  ".ppt": "pptx",
  ".pptx": "pptx",
};

/**
 * Detect document format from file extension.
 * Returns null for unsupported formats.
 */
export function detectFormat(filepath: string): DocumentBackend["format"] | null {
  const lastDot = filepath.lastIndexOf(".");
  if (lastDot === -1) return null;
  const ext = filepath.slice(lastDot).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

/**
 * Internal Store type that includes backend cache.
 * This extends the public Store type with internal properties.
 */
interface StoreWithBackends extends Store {
  _backends?: Map<DocumentBackend["format"], DocumentBackend>;
}

/**
 * Get the backend instance for a given format.
 * Backends are lazily created and cached per store.
 *
 * @param format - The document format (md, pdf, docx, pptx)
 * @param store - The QMD store instance
 * @returns The backend instance for the format
 */
export async function getBackend(
  format: DocumentBackend["format"],
  store: Store
): Promise<DocumentBackend> {
  const internalStore = store as StoreWithBackends;

  if (!internalStore._backends) {
    internalStore._backends = new Map();
  }

  let backend = internalStore._backends.get(format);
  if (!backend) {
    switch (format) {
      case "md": {
        const { createMarkdownBackend } = await import("./markdown.js");
        backend = createMarkdownBackend(store);
        break;
      }
      case "pdf": {
        const { createPdfBackend } = await import("./pdf.js");
        backend = createPdfBackend(store);
        break;
      }
      case "docx": {
        const { createDocxBackend } = await import("./docx.js");
        backend = createDocxBackend(store);
        break;
      }
      case "pptx": {
        const { createPptxBackend } = await import("./pptx.js");
        backend = createPptxBackend(store);
        break;
      }
      default:
        throw new Error(`Unknown format: ${format}`);
    }
    internalStore._backends.set(format, backend);
  }

  return backend;
}

/**
 * Clear all cached backends for a store.
 * Useful for testing or when backends need to be recreated.
 */
export function clearBackends(store: Store): void {
  const internalStore = store as StoreWithBackends;
  internalStore._backends?.clear();
}
