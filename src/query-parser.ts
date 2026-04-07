/**
 * Structured search query parser.
 *
 * Parses multi-line query syntax with lex:/vec:/hyde:/intent: prefixes.
 * Extracted to a shared module so both CLI and tests use the same implementation.
 */

import type { ExpandedQuery } from "./store.js";

export interface ParsedStructuredQuery {
  searches: ExpandedQuery[];
  intent?: string;
}

/**
 * Parse structured search query syntax.
 * Lines starting with lex:, vec:, or hyde: are routed directly.
 * Plain lines without prefix go through query expansion.
 *
 * Returns null if this is a plain query (single line, no prefix).
 * Returns ParsedStructuredQuery if structured syntax detected.
 * Throws if multiple plain lines (ambiguous).
 *
 * Examples:
 *   "CAP theorem"                    -> null (plain query, use expansion)
 *   "lex: CAP theorem"               -> { searches: [{ type: 'lex', query: 'CAP theorem' }] }
 *   "lex: CAP\nvec: consistency"     -> { searches: [{ type: 'lex', ... }, { type: 'vec', ... }] }
 *   "intent: databases\nlex: CAP"    -> { searches: [...], intent: 'databases' }
 *   "CAP\nconsistency"               -> throws (multiple plain lines)
 */
export function parseStructuredQuery(query: string): ParsedStructuredQuery | null {
  const rawLines = query.split('\n').map((line, idx) => ({
    raw: line,
    trimmed: line.trim(),
    number: idx + 1,
  })).filter(line => line.trimmed.length > 0);

  if (rawLines.length === 0) return null;

  const prefixRe = /^(lex|vec|hyde):\s*/i;
  const expandRe = /^expand:\s*/i;
  const intentRe = /^intent:\s*/i;
  const typed: ExpandedQuery[] = [];
  let intent: string | undefined;

  for (const line of rawLines) {
    if (expandRe.test(line.trimmed)) {
      if (rawLines.length > 1) {
        throw new Error(`Line ${line.number} starts with expand:, but query documents cannot mix expand with typed lines. Submit a single expand query instead.`);
      }
      const text = line.trimmed.replace(expandRe, '').trim();
      if (!text) {
        throw new Error('expand: query must include text.');
      }
      return null;
    }

    if (intentRe.test(line.trimmed)) {
      if (intent !== undefined) {
        throw new Error(`Line ${line.number}: only one intent: line is allowed per query document.`);
      }
      const text = line.trimmed.replace(intentRe, '').trim();
      if (!text) {
        throw new Error(`Line ${line.number}: intent: must include text.`);
      }
      intent = text;
      continue;
    }

    const match = line.trimmed.match(prefixRe);
    if (match) {
      const type = match[1]!.toLowerCase() as 'lex' | 'vec' | 'hyde';
      const text = line.trimmed.slice(match[0].length).trim();
      if (!text) {
        throw new Error(`Line ${line.number} (${type}:) must include text.`);
      }
      if (/\r|\n/.test(text)) {
        throw new Error(`Line ${line.number} (${type}:) contains a newline. Keep each query on a single line.`);
      }
      typed.push({ type, query: text, line: line.number });
      continue;
    }

    if (rawLines.length === 1) {
      return null;
    }

    throw new Error(`Line ${line.number} is missing a lex:/vec:/hyde:/intent: prefix. Each line in a query document must start with one.`);
  }

  if (intent && typed.length === 0) {
    throw new Error('intent: cannot appear alone. Add at least one lex:, vec:, or hyde: line.');
  }

  return typed.length > 0 ? { searches: typed, intent } : null;
}
