/**
 * Wiki index generator — auto-generates index.md for a wiki collection.
 *
 * Scans all documents in a wiki collection, organizes by directory structure,
 * and produces a navigable index with one-line summaries.
 */

import type { Database } from "../db.js";
import { getStoreCollection, getDocid } from "../store.js";

// =============================================================================
// Types
// =============================================================================

export interface WikiIndexOptions {
  collection: string;
  include_summaries?: boolean;
}

export interface WikiIndexResult {
  markdown: string;
  page_count: number;
  category_count: number;
}

// =============================================================================
// Generate
// =============================================================================

export function generateWikiIndex(db: Database, opts: WikiIndexOptions): WikiIndexResult {
  const coll = getStoreCollection(db, opts.collection);
  if (!coll) {
    throw new Error(`Collection not found: ${opts.collection}`);
  }

  const docs = db.prepare(`
    SELECT
      d.path, d.title, d.hash, d.modified_at,
      d.collection || '/' || d.path as display_path
    FROM documents d
    WHERE d.collection = ? AND d.active = 1
    ORDER BY d.path
  `).all(opts.collection) as {
    path: string; title: string; hash: string; modified_at: string; display_path: string;
  }[];

  // Group by top-level directory
  const categories = new Map<string, typeof docs>();
  const rootDocs: typeof docs = [];

  for (const doc of docs) {
    // Skip the index page itself
    if (doc.path === "index.md") continue;

    const parts = doc.path.split("/");
    if (parts.length > 1) {
      const category = parts[0]!;
      const existing = categories.get(category) ?? [];
      existing.push(doc);
      categories.set(category, existing);
    } else {
      rootDocs.push(doc);
    }
  }

  // Build markdown
  const lines: string[] = [];
  lines.push(`# ${opts.collection} Wiki Index`);
  lines.push("");
  lines.push(`> Auto-generated index of ${docs.length} pages. Last updated: ${new Date().toISOString().split("T")[0]}`);
  lines.push("");

  // Root-level docs
  if (rootDocs.length > 0) {
    lines.push("## General");
    lines.push("");
    for (const doc of rootDocs) {
      const docid = getDocid(doc.hash);
      lines.push(`- [[${doc.path.replace(/\.md$/, "")}]] — ${doc.title} (${docid})`);
    }
    lines.push("");
  }

  // Category sections
  const sortedCategories = Array.from(categories.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [category, catDocs] of sortedCategories) {
    const label = category.charAt(0).toUpperCase() + category.slice(1);
    lines.push(`## ${label}`);
    lines.push("");
    for (const doc of catDocs) {
      const docid = getDocid(doc.hash);
      const relativePath = doc.path.replace(/\.md$/, "");
      lines.push(`- [[${relativePath}]] — ${doc.title} (${docid})`);
    }
    lines.push("");
  }

  const listedCount = docs.filter(d => d.path !== "index.md").length;
  return {
    markdown: lines.join("\n"),
    page_count: listedCount,
    category_count: categories.size + (rootDocs.length > 0 ? 1 : 0),
  };
}
