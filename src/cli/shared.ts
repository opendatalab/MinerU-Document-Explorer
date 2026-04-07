/**
 * Shared CLI state and utilities.
 *
 * This module owns the singleton store/db lifecycle and provides
 * terminal formatting helpers used by all command modules.
 */

import type { Database } from "../db.js";
import { existsSync, readdirSync, statSync, readFileSync, unlinkSync } from "fs";
import {
  enableProductionMode,
  getDefaultDbPath,
  createStore,
  syncConfigToDb,
  getIndexHealth,
  addLineNumbers as _addLineNumbers,
  DEFAULT_EMBED_MODEL,
  DEFAULT_MULTI_GET_MAX_BYTES,
} from "../store.js";
import { DEFAULT_MODEL_CACHE_DIR, DEFAULT_EMBED_MODEL_URI, DEFAULT_GENERATE_MODEL_URI, DEFAULT_RERANK_MODEL_URI } from "../llm.js";
import { loadConfig, setConfigIndexName as _setConfigIndexName } from "../collections.js";
import { homedir, resolve } from "../store.js";

enableProductionMode();

// ---------------------------------------------------------------------------
// Store / DB lifecycle
// ---------------------------------------------------------------------------

let store: ReturnType<typeof createStore> | null = null;
let storeDbPathOverride: string | undefined;

export function getStore(): ReturnType<typeof createStore> {
  if (!store) {
    store = createStore(storeDbPathOverride);
    try {
      const config = loadConfig();
      syncConfigToDb(store.db, config);
    } catch {
      // Config may not exist yet
    }
  }
  return store;
}

export function getDb(): Database {
  return getStore().db;
}

export function resyncConfig(): void {
  const s = getStore();
  try {
    const config = loadConfig();
    syncConfigToDb(s.db, config);
  } catch {
    // Config may not exist
  }
}

export function closeDb(): void {
  if (store) {
    store.close();
    store = null;
  }
}

export function getDbPath(): string {
  return store?.dbPath ?? storeDbPathOverride ?? getDefaultDbPath();
}

export function setIndexName(name: string | null): void {
  let normalizedName = name;
  if (name && name.includes('/')) {
    const { resolve } = require('path');
    const { cwd } = require('process');
    const absolutePath = resolve(cwd(), name);
    normalizedName = absolutePath.replace(/\//g, '_').replace(/^_/, '');
  }
  storeDbPathOverride = normalizedName ? getDefaultDbPath(normalizedName) : undefined;
  closeDb();
}

export function ensureVecTable(_db: Database, dimensions: number): void {
  getStore().ensureVecTable(dimensions);
}

// ---------------------------------------------------------------------------
// Terminal colors (respects NO_COLOR env)
// ---------------------------------------------------------------------------

export const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
export const c = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  green: useColor ? "\x1b[32m" : "",
  magenta: useColor ? "\x1b[35m" : "",
  blue: useColor ? "\x1b[34m" : "",
};

// ---------------------------------------------------------------------------
// Terminal cursor and progress
// ---------------------------------------------------------------------------

export const cursor = {
  hide() { process.stderr.write('\x1b[?25l'); },
  show() { process.stderr.write('\x1b[?25h'); },
};

export const isTTY = process.stderr.isTTY;

export const progress = {
  set(percent: number) {
    if (isTTY) process.stderr.write(`\x1b]9;4;1;${Math.round(percent)}\x07`);
  },
  clear() {
    if (isTTY) process.stderr.write(`\x1b]9;4;0\x07`);
  },
  indeterminate() {
    if (isTTY) process.stderr.write(`\x1b]9;4;3\x07`);
  },
  error() {
    if (isTTY) process.stderr.write(`\x1b]9;4;2\x07`);
  },
};

// Ensure cursor is restored and DB closed on exit
process.on('SIGINT', () => { cursor.show(); progress.clear(); try { closeDb(); } catch {} process.exit(130); });
process.on('SIGTERM', () => { cursor.show(); progress.clear(); try { closeDb(); } catch {} process.exit(143); });

// ---------------------------------------------------------------------------
// Formatting utilities
// ---------------------------------------------------------------------------

export function formatETA(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function renderProgressBar(percent: number, width: number = 30): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

export function shortPath(dirpath: string): string {
  const home = homedir();
  if (dirpath.startsWith(home)) {
    return '~' + dirpath.slice(home.length);
  }
  return dirpath;
}

// ---------------------------------------------------------------------------
// Model notice (first-run download warning)
// ---------------------------------------------------------------------------

export function printModelNotice(models: string[]): void {
  const cacheDir = DEFAULT_MODEL_CACHE_DIR;
  const missing: { name: string; size: string }[] = [];
  for (const uri of models) {
    const filename = uri.split("/").pop();
    if (!filename) continue;
    const cached = existsSync(cacheDir) &&
      readdirSync(cacheDir).some(f => f.includes(filename));
    if (!cached) {
      if (uri.includes("embed")) missing.push({ name: "embeddinggemma-300M", size: "~300MB" });
      else if (uri.includes("reranker")) missing.push({ name: "qwen3-reranker-0.6b", size: "~640MB" });
      else if (uri.includes("expansion")) missing.push({ name: "qmd-query-expansion-1.7B", size: "~1.1GB" });
    }
  }
  if (missing.length > 0) {
    const total = missing.map(m => m.size).join(" + ");
    process.stderr.write(`${c.dim}ℹ First run: downloading ${missing.length} model${missing.length > 1 ? "s" : ""} (${total}). This only happens once.${c.reset}\n`);
    for (const m of missing) {
      process.stderr.write(`${c.dim}  ${m.name} (${m.size})${c.reset}\n`);
    }
    process.stderr.write(`${c.dim}  Tip: use 'qmd search' for instant keyword search with no downloads.${c.reset}\n`);
  }
}

// ---------------------------------------------------------------------------
// Index health check
// ---------------------------------------------------------------------------

export function checkIndexHealth(db: Database): void {
  const { needsEmbedding, totalDocs, daysStale } = getIndexHealth(db);

  if (needsEmbedding > 0) {
    const pct = Math.round((needsEmbedding / totalDocs) * 100);
    if (pct >= 10) {
      process.stderr.write(`${c.yellow}Warning: ${needsEmbedding} documents (${pct}%) need embeddings. Run 'qmd embed' for better results.${c.reset}\n`);
    } else {
      process.stderr.write(`${c.dim}Tip: ${needsEmbedding} documents need embeddings. Run 'qmd embed' to index them.${c.reset}\n`);
    }
  }

  if (daysStale !== null && daysStale >= 14) {
    process.stderr.write(`${c.dim}Tip: Index last updated ${daysStale} days ago. Run 'qmd update' to refresh.${c.reset}\n`);
  }
}

// Display path computation
export function computeDisplayPath(
  filepath: string,
  collectionPath: string,
  existingPaths: Set<string>
): string {
  const collectionDir = collectionPath.replace(/\/$/, '');
  const collectionName = collectionDir.split('/').pop() || '';
  let relativePath: string;
  if (filepath.startsWith(collectionDir + '/')) {
    relativePath = collectionName + filepath.slice(collectionDir.length);
  } else {
    relativePath = filepath;
  }
  const parts = relativePath.split('/').filter(p => p.length > 0);
  const minParts = Math.min(2, parts.length);
  for (let i = parts.length - minParts; i >= 0; i--) {
    const candidate = parts.slice(i).join('/');
    if (!existingPaths.has(candidate)) {
      return candidate;
    }
  }
  return filepath;
}

// Re-export constants used by commands
export { DEFAULT_EMBED_MODEL, DEFAULT_MULTI_GET_MAX_BYTES };
export { DEFAULT_EMBED_MODEL_URI, DEFAULT_GENERATE_MODEL_URI, DEFAULT_RERANK_MODEL_URI, DEFAULT_MODEL_CACHE_DIR };
