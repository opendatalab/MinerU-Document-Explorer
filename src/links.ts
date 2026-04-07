/**
 * Link parser for QMD — extracts [[wikilinks]] and [markdown](links) from content.
 * Used during indexing to populate the links table for bidirectional navigation.
 *
 * Links inside code fences (``` blocks) are now correctly skipped.
 */

export type LinkType = "wikilink" | "markdown" | "url";

export interface ParsedLink {
  target: string;       // raw link target (wikilink name, relative path, or URL)
  link_type: LinkType;
  anchor?: string;      // display text
  line: number;         // 1-indexed line number in source
}

// [[target]] or [[target|display text]] or [[target#heading|display]]
const WIKILINK_RE = /\[\[([^\]|#\n]+?)(?:#[^\]|]*)?\s*(?:\|([^\]]+))?\]\]/g;

// [text](url-or-path) — NOT image links (preceded by !)
// Uses negative lookbehind for !
const MARKDOWN_LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)\s][^)]*)\)/g;

/**
 * Find all code fence regions in the text.
 * Code fences are delimited by ``` and may have a language specifier.
 */
function findCodeFenceRegions(content: string): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  const fencePattern = /^ {0,3}```/gm;
  let inFence = false;
  let fenceStart = 0;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(content)) !== null) {
    if (!inFence) {
      fenceStart = match.index;
      inFence = true;
    } else {
      // Include the closing ``` in the region
      const endOfLine = content.indexOf("\n", match.index);
      regions.push({
        start: fenceStart,
        end: endOfLine === -1 ? content.length : endOfLine,
      });
      inFence = false;
    }
  }

  // Handle unclosed fence - extends to end of document
  if (inFence) {
    regions.push({ start: fenceStart, end: content.length });
  }

  return regions;
}

/**
 * Check if a position is inside any of the code fence regions.
 */
function isInsideCodeFence(pos: number, regions: Array<{ start: number; end: number }>): boolean {
  return regions.some(r => pos > r.start && pos < r.end);
}

/**
 * Parse links from content, skipping those inside code fences.
 */
export function parseLinks(content: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  const lines = content.split("\n");

  // Pre-compute code fence regions for efficient lookup
  const codeFenceRegions = findCodeFenceRegions(content);

  // Track character position for each line
  let charPos = 0;
  const linePositions = lines.map((line, i) => {
    const pos = charPos;
    charPos += line.length + 1; // +1 for newline
    return pos;
  });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;
    const lineStartPos = linePositions[i]!;

    // Parse wikilinks: [[target]] or [[target|display text]]
    for (const match of line.matchAll(WIKILINK_RE)) {
      if (match.index !== undefined && isInsideCodeFence(lineStartPos + match.index, codeFenceRegions)) {
        continue; // Skip links inside code fences
      }
      const target = match[1]!.trim();
      const anchor = match[2]?.trim();
      if (target) {
        links.push({ target, link_type: "wikilink", anchor, line: lineNum });
      }
    }

    // Parse markdown links: [text](target)
    for (const match of line.matchAll(MARKDOWN_LINK_RE)) {
      if (match.index !== undefined && isInsideCodeFence(lineStartPos + match.index, codeFenceRegions)) {
        continue; // Skip links inside code fences
      }
      const anchor = match[1]!;
      const rawTarget = match[2]!.trim();
      if (!rawTarget) continue;

      const isUrl =
        rawTarget.startsWith("http://") ||
        rawTarget.startsWith("https://") ||
        rawTarget.startsWith("ftp://") ||
        rawTarget.startsWith("mailto:");

      links.push({
        target: rawTarget,
        link_type: isUrl ? "url" : "markdown",
        anchor,
        line: lineNum,
      });
    }
  }

  return links;
}
