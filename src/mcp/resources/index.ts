/**
 * MCP Resources registration — document resource.
 */

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QMDStore } from "../../index.js";
import { addLineNumbers } from "../../index.js";

/**
 * Register the qmd://document resource.
 * Note: No list() - documents are discovered via search tools.
 */
export function registerDocumentResource(server: McpServer, store: QMDStore): void {
  server.registerResource(
    "document",
    new ResourceTemplate("qmd://{+path}", { list: undefined }),
    {
      title: "QMD Document",
      description: "A markdown document from your QMD knowledge base. Use search tools to discover documents.",
      mimeType: "text/markdown",
    },
    async (uri, { path }) => {
      // Decode URL-encoded path (MCP clients send encoded URIs)
      const pathStr = Array.isArray(path) ? path.join('/') : (path || '');
      const decodedPath = decodeURIComponent(pathStr);

      // Use SDK to find document — findDocument handles collection/path resolution
      const result = await store.get(decodedPath, { includeBody: true });

      if ("error" in result) {
        return { contents: [{ uri: uri.href, text: `Document not found: ${decodedPath}` }] };
      }

      let text = addLineNumbers(result.body || "");  // Default to line numbers
      if (result.context) {
        text = `<!-- Context: ${result.context} -->\n\n` + text;
      }

      return {
        contents: [{
          uri: uri.href,
          name: result.displayPath,
          title: result.title || result.displayPath,
          mimeType: "text/markdown",
          text,
        }],
      };
    }
  );
}

/**
 * Handle document resource retrieval (standalone function for external use).
 */
export async function handleDocumentResource(uri: URL, pathStr: string, store: QMDStore) {
  const decodedPath = decodeURIComponent(
    Array.isArray(pathStr) ? pathStr.join('/') : (pathStr || '')
  );

  const result = await store.get(decodedPath, { includeBody: true });

  if ("error" in result) {
    return { contents: [{ uri: uri.href, text: `Document not found: ${decodedPath}` }] };
  }

  let text = addLineNumbers(result.body || "");
  if (result.context) {
    text = `<!-- Context: ${result.context} -->\n\n` + text;
  }

  return {
    contents: [{
      uri: uri.href,
      name: result.displayPath,
      title: result.title || result.displayPath,
      mimeType: "text/markdown",
      text,
    }],
  };
}
