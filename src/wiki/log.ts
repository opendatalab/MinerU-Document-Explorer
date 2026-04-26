/**
 * Wiki activity log — append-only record of wiki operations.
 *
 * Tracks ingest, update, lint, and query operations with timestamps,
 * affected files, and session grouping for timeline reconstruction.
 */

import type { Database } from "../db.js";

// =============================================================================
// Types
// =============================================================================

export type WikiOperation =
  | "ingest"
  | "update"
  | "lint"
  | "query"
  | "index"
  | "web_search"
  | "web_fetch";

export interface WikiLogEntry {
  id?: number;
  timestamp?: string;
  operation: WikiOperation;
  source_file?: string;
  wiki_files?: string[];
  details?: Record<string, unknown>;
  session_id?: string;
}

export interface WikiLogRow {
  id: number;
  timestamp: string;
  operation: string;
  source_file: string | null;
  wiki_files: string | null;
  details: string | null;
  session_id: string | null;
}

export interface WikiLogQuery {
  since?: string;
  operation?: WikiOperation;
  limit?: number;
  session_id?: string;
}

// =============================================================================
// Write
// =============================================================================

export function appendLog(db: Database, entry: WikiLogEntry): number {
  const result = db.prepare(`
    INSERT INTO wiki_log (operation, source_file, wiki_files, details, session_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    entry.operation,
    entry.source_file || null,
    entry.wiki_files ? JSON.stringify(entry.wiki_files) : null,
    entry.details ? JSON.stringify(entry.details) : null,
    entry.session_id || null,
  );
  return Number(result.lastInsertRowid);
}

// =============================================================================
// Read
// =============================================================================

export function queryLog(db: Database, opts: WikiLogQuery = {}): WikiLogEntry[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.since) {
    conditions.push("timestamp >= ?");
    params.push(opts.since);
  }
  if (opts.operation) {
    conditions.push("operation = ?");
    params.push(opts.operation);
  }
  if (opts.session_id) {
    conditions.push("session_id = ?");
    params.push(opts.session_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 50;

  const rows = db.prepare(`
    SELECT id, timestamp, operation, source_file, wiki_files, details, session_id
    FROM wiki_log ${where}
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(...params, limit) as WikiLogRow[];

  return rows.map(rowToEntry);
}

export function getLogStats(db: Database): {
  total: number;
  byOperation: Record<string, number>;
  lastEntry: string | null;
} {
  const total = (db.prepare(`SELECT COUNT(*) as c FROM wiki_log`).get() as { c: number }).c;

  const ops = db.prepare(`
    SELECT operation, COUNT(*) as c FROM wiki_log GROUP BY operation
  `).all() as { operation: string; c: number }[];
  const byOperation: Record<string, number> = {};
  for (const op of ops) byOperation[op.operation] = op.c;

  const last = db.prepare(`
    SELECT timestamp FROM wiki_log ORDER BY timestamp DESC LIMIT 1
  `).get() as { timestamp: string } | undefined;

  return { total, byOperation, lastEntry: last?.timestamp ?? null };
}

// =============================================================================
// Format
// =============================================================================

export function formatLogAsMarkdown(entries: WikiLogEntry[]): string {
  if (entries.length === 0) return "No activity recorded yet.";

  const lines: string[] = ["# Wiki Activity Log", ""];

  for (const entry of entries) {
    const ts = entry.timestamp ?? "unknown";
    const op = entry.operation;
    const source = entry.source_file ? ` | ${entry.source_file}` : "";
    lines.push(`## [${ts}] ${op}${source}`);

    if (entry.wiki_files && entry.wiki_files.length > 0) {
      lines.push("");
      lines.push("Files touched:");
      for (const f of entry.wiki_files) {
        lines.push(`- ${f}`);
      }
    }

    if (entry.details && Object.keys(entry.details).length > 0) {
      lines.push("");
      for (const [k, v] of Object.entries(entry.details)) {
        lines.push(`- **${k}**: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

// =============================================================================
// Internal
// =============================================================================

function safeJsonParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

function rowToEntry(row: WikiLogRow): WikiLogEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    operation: row.operation as WikiOperation,
    ...(row.source_file ? { source_file: row.source_file } : {}),
    ...(row.wiki_files ? { wiki_files: safeJsonParse<string[]>(row.wiki_files, []) } : {}),
    ...(row.details ? { details: safeJsonParse<Record<string, unknown>>(row.details, {}) } : {}),
    ...(row.session_id ? { session_id: row.session_id } : {}),
  };
}
