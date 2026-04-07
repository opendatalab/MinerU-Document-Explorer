/**
 * db.ts - Cross-runtime SQLite compatibility layer
 *
 * Provides a unified Database export that works under both Bun (bun:sqlite)
 * and Node.js (better-sqlite3). The APIs are nearly identical — the main
 * difference is the import path.
 *
 * On macOS + Bun, Apple's bundled SQLite disables extension loading.
 * We detect Homebrew's vanilla SQLite and call setCustomSQLite() so that
 * sqlite-vec can be loaded.
 */

import { existsSync } from "fs";
import { execSync } from "child_process";

export const isBun = typeof globalThis.Bun !== "undefined";

let _Database: any;
let _sqliteVecLoad: (db: any) => void;

/**
 * Locate Homebrew's libsqlite3.dylib on macOS.
 * Returns the path if found, undefined otherwise.
 */
function findBrewSqlitePath(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const prefixes = [
    process.env.BREW_PREFIX,
    "/opt/homebrew",
    "/usr/local",
  ];
  for (const prefix of prefixes) {
    if (!prefix) continue;
    const candidate = `${prefix}/opt/sqlite/lib/libsqlite3.dylib`;
    if (existsSync(candidate)) return candidate;
  }
  try {
    const brewPrefix = execSync("brew --prefix 2>/dev/null", { encoding: "utf8" }).trim();
    if (brewPrefix) {
      const candidate = `${brewPrefix}/opt/sqlite/lib/libsqlite3.dylib`;
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // brew not installed
  }
  return undefined;
}

if (isBun) {
  const bunSqlite = "bun:" + "sqlite";
  _Database = (await import(/* @vite-ignore */ bunSqlite)).Database;

  // On macOS, switch to Homebrew's SQLite to enable extension loading
  if (process.platform === "darwin" && typeof _Database.setCustomSQLite === "function") {
    const brewSqlitePath = findBrewSqlitePath();
    if (brewSqlitePath) {
      _Database.setCustomSQLite(brewSqlitePath);
    }
  }

  const { getLoadablePath } = await import("sqlite-vec");
  _sqliteVecLoad = (db: any) => db.loadExtension(getLoadablePath());
} else {
  _Database = (await import("better-sqlite3")).default;
  const sqliteVec = await import("sqlite-vec");
  _sqliteVecLoad = (db: any) => sqliteVec.load(db);
}

/**
 * Open a SQLite database. Works with both bun:sqlite and better-sqlite3.
 */
export function openDatabase(path: string): Database {
  return new _Database(path) as Database;
}

/**
 * Common subset of the Database interface used throughout QMD.
 */
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  loadExtension(path: string): void;
  close(): void;
}

export interface Statement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

/**
 * Load the sqlite-vec extension into a database.
 */
export function loadSqliteVec(db: Database): void {
  _sqliteVecLoad(db);
}
