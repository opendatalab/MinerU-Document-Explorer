/**
 * Wiki lint — link graph health analysis.
 *
 * Detects orphan pages, broken wikilinks, missing pages (referenced but not
 * created), hub pages (high inbound count), and stale pages.
 */

import type { Database } from "../db.js";

// =============================================================================
// Types
// =============================================================================

export interface WikiLintResult {
  orphan_pages: string[];
  broken_links: { source: string; target: string; link_type: string }[];
  missing_pages: { target: string; referenced_by: string[]; ref_count: number }[];
  hub_pages: { file: string; inbound_count: number }[];
  stale_pages: { file: string; last_updated: string; days_ago: number }[];
  source_stale_pages: { wiki_file: string; source_file: string; wiki_updated: string; source_updated: string; days_behind: number }[];
  stats: {
    total_pages: number;
    total_links: number;
    wiki_pages: number;
  };
  suggestions: string[];
}

export interface WikiLintOptions {
  collection?: string;
  stale_days?: number;
  hub_threshold?: number;
}

// =============================================================================
// Lint
// =============================================================================

export function lintWiki(db: Database, opts: WikiLintOptions = {}): WikiLintResult {
  const staleDays = opts.stale_days ?? 30;
  const hubThreshold = opts.hub_threshold ?? 5;

  // All active documents
  const allDocs = db.prepare(`
    SELECT collection, path, collection || '/' || path as display_path, modified_at
    FROM documents WHERE active = 1
    ${opts.collection ? "AND collection = ?" : ""}
  `).all(...(opts.collection ? [opts.collection] : [])) as {
    collection: string; path: string; display_path: string; modified_at: string;
  }[];

  const docPaths = new Set(allDocs.map(d => d.display_path));

  // Build title→display_path map for wikilink title resolution
  const allDocsWithTitle = db.prepare(`
    SELECT collection || '/' || path as display_path, title
    FROM documents WHERE active = 1
    ${opts.collection ? "AND collection = ?" : ""}
  `).all(...(opts.collection ? [opts.collection] : [])) as {
    display_path: string; title: string;
  }[];
  const titleToPath = new Map<string, string>();
  for (const d of allDocsWithTitle) {
    if (d.title) titleToPath.set(d.title.toLowerCase(), d.display_path);
  }

  // Wiki-type collections
  const wikiColls = db.prepare(`
    SELECT name FROM store_collections WHERE type = 'wiki'
  `).all() as { name: string }[];
  const wikiCollNames = new Set(wikiColls.map(c => c.name));

  const wikiDocs = allDocs.filter(d => wikiCollNames.has(d.collection));
  const wikiPaths = new Set(wikiDocs.map(d => d.display_path));

  // All links (scoped to collection if specified)
  const allLinks = db.prepare(`
    SELECT source, target, link_type FROM links
    ${opts.collection ? "WHERE source LIKE ? || '/%'" : ""}
  `).all(...(opts.collection ? [opts.collection] : [])) as { source: string; target: string; link_type: string }[];

  // Resolve a wikilink target to its display_path, or null if unresolvable.
  function resolveWikilink(target: string): string | null {
    // 1. Exact path match
    if (docPaths.has(target)) return target;
    // 2. Path suffix match (e.g. "sources/distributed-systems-overview" → collection/sources/...)
    for (const dp of docPaths) {
      if (dp.endsWith("/" + target + ".md") || dp.endsWith("/" + target)) {
        return dp;
      }
    }
    // 3. Title match, case-insensitive (e.g. "CAP theorem" → collection/concepts/cap-theorem.md)
    const byTitle = titleToPath.get(target.toLowerCase());
    if (byTitle) return byTitle;
    return null;
  }

  // --- Orphan pages: wiki pages with no inbound links ---
  const inboundTargets = new Set<string>();
  for (const link of allLinks) {
    inboundTargets.add(link.target);
    if (link.link_type === "wikilink") {
      const resolved = resolveWikilink(link.target);
      if (resolved) inboundTargets.add(resolved);
    }
  }
  const orphan_pages = wikiDocs
    .filter(d => !inboundTargets.has(d.display_path))
    .map(d => d.display_path);

  // --- Broken links: link targets not matching any document ---
  const broken_links: WikiLintResult["broken_links"] = [];
  for (const link of allLinks) {
    if (link.link_type === "url") continue;

    let found = false;
    if (docPaths.has(link.target)) {
      found = true;
    } else if (link.link_type === "wikilink") {
      found = resolveWikilink(link.target) !== null;
    } else if (link.link_type === "markdown") {
      const sourceParts = link.source.split("/");
      sourceParts.pop();
      const joined = [...sourceParts, link.target].join("/");
      // Normalize ../sibling and ./local paths
      const segments = joined.split("/");
      const normalized: string[] = [];
      for (const seg of segments) {
        if (seg === "..") { normalized.pop(); }
        else if (seg !== "." && seg !== "") { normalized.push(seg); }
      }
      const resolved = normalized.join("/");
      if (docPaths.has(resolved)) found = true;
      if (!found && docPaths.has(resolved + ".md")) found = true;
    }

    if (!found) {
      broken_links.push({ source: link.source, target: link.target, link_type: link.link_type });
    }
  }

  // --- Missing pages: broken link targets referenced by multiple sources ---
  const missingTargetRefs = new Map<string, Set<string>>();
  for (const bl of broken_links) {
    const refs = missingTargetRefs.get(bl.target) ?? new Set();
    refs.add(bl.source);
    missingTargetRefs.set(bl.target, refs);
  }
  const missing_pages = Array.from(missingTargetRefs.entries())
    .filter(([_, refs]) => refs.size >= 2)
    .map(([target, refs]) => ({
      target,
      referenced_by: Array.from(refs),
      ref_count: refs.size,
    }))
    .sort((a, b) => b.ref_count - a.ref_count);

  // --- Hub pages: pages with high inbound link count ---
  const inboundCount = new Map<string, number>();
  for (const link of allLinks) {
    if (link.link_type === "url") continue;
    let resolvedTarget = link.target;
    if (link.link_type === "wikilink") {
      resolvedTarget = resolveWikilink(link.target) ?? link.target;
    }
    if (docPaths.has(resolvedTarget)) {
      inboundCount.set(resolvedTarget, (inboundCount.get(resolvedTarget) ?? 0) + 1);
    }
  }
  const hub_pages = Array.from(inboundCount.entries())
    .filter(([_, count]) => count >= hubThreshold)
    .map(([file, inbound_count]) => ({ file, inbound_count }))
    .sort((a, b) => b.inbound_count - a.inbound_count);

  // --- Stale pages: wiki pages not updated in staleDays ---
  const now = Date.now();
  const stale_pages = wikiDocs
    .filter(d => {
      if (!d.modified_at) return false;
      const daysAgo = (now - new Date(d.modified_at).getTime()) / (1000 * 60 * 60 * 24);
      return daysAgo >= staleDays;
    })
    .map(d => ({
      file: d.display_path,
      last_updated: d.modified_at,
      days_ago: Math.floor((now - new Date(d.modified_at).getTime()) / (1000 * 60 * 60 * 24)),
    }))
    .sort((a, b) => b.days_ago - a.days_ago);

  // --- Source-stale pages: wiki pages whose source docs have been updated ---
  const source_stale_pages: WikiLintResult["source_stale_pages"] = [];
  try {
    const rows = db.prepare(`
      SELECT ws.wiki_file, ws.source_file,
             wd.modified_at as wiki_updated,
             sd.modified_at as source_updated
      FROM wiki_sources ws
      JOIN documents wd ON wd.collection || '/' || wd.path = ws.wiki_file AND wd.active = 1
      JOIN documents sd ON sd.collection || '/' || sd.path = ws.source_file AND sd.active = 1
      WHERE sd.modified_at > wd.modified_at
      ${opts.collection ? "AND ws.wiki_collection = ?" : ""}
      ORDER BY sd.modified_at DESC
    `).all(...(opts.collection ? [opts.collection] : [])) as {
      wiki_file: string; source_file: string; wiki_updated: string; source_updated: string;
    }[];

    for (const r of rows) {
      const daysBehind = Math.floor(
        (new Date(r.source_updated).getTime() - new Date(r.wiki_updated).getTime()) / (1000 * 60 * 60 * 24)
      );
      source_stale_pages.push({ ...r, days_behind: daysBehind });
    }
  } catch {
    // wiki_sources table may not exist in older DBs
  }

  // --- Suggestions ---
  const suggestions: string[] = [];
  if (orphan_pages.length > 0) {
    suggestions.push(`${orphan_pages.length} wiki page(s) have no inbound links — consider adding cross-references.`);
  }
  if (broken_links.length > 0) {
    suggestions.push(`${broken_links.length} broken link(s) found — create missing pages or fix link targets.`);
  }
  if (missing_pages.length > 0) {
    suggestions.push(`${missing_pages.length} topic(s) are referenced multiple times but have no page — consider creating them.`);
  }
  if (stale_pages.length > 0) {
    suggestions.push(`${stale_pages.length} wiki page(s) haven't been updated in ${staleDays}+ days — review for accuracy.`);
  }
  if (source_stale_pages.length > 0) {
    suggestions.push(`${source_stale_pages.length} wiki page(s) have outdated sources — re-ingest and update them.`);
  }
  if (wikiDocs.length === 0 && wikiColls.length === 0) {
    suggestions.push("No wiki collections found. Create one with: qmd collection add <path> --name <name> --type wiki");
  }

  return {
    orphan_pages,
    broken_links,
    missing_pages,
    hub_pages,
    stale_pages,
    source_stale_pages,
    stats: {
      total_pages: allDocs.length,
      total_links: allLinks.length,
      wiki_pages: wikiDocs.length,
    },
    suggestions,
  };
}
