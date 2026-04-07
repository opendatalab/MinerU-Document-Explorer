# CLI Reference

## Collection Management

```sh
# Create a collection from current directory
qmd collection add . --name myproject

# Create a collection with explicit path and custom glob mask
qmd collection add ~/Documents/notes --name notes --mask "**/*.md"

# Index multiple formats (PDF, DOCX, PPTX)
qmd collection add ~/papers --name papers --mask "**/*.{md,pdf,docx,pptx}"

# Create a wiki collection (LLM-maintained)
qmd collection add ~/wiki --name mywiki --type wiki

# List all collections
qmd collection list

# Remove a collection
qmd collection remove myproject

# Rename a collection
qmd collection rename myproject my-project

# List files in a collection
qmd ls notes
qmd ls notes/subfolder
```

## Search

```
┌──────────────────────────────────────────────────────────────────┐
│                        Search Modes                              │
├──────────┬───────────────────────────────────────────────────────┤
│ search   │ BM25 full-text search only (fast, no LLM)            │
│ vsearch  │ Vector semantic search only                          │
│ query    │ Hybrid: FTS + Vector + Query Expansion + Re-ranking  │
└──────────┴───────────────────────────────────────────────────────┘
```

```sh
# Full-text search (fast, keyword-based)
qmd search "authentication flow"

# Vector search (semantic similarity)
qmd vsearch "how to login"

# Hybrid search with re-ranking (best quality)
qmd query "user authentication"

# Get 10 results with minimum score 0.3
qmd query -n 10 --min-score 0.3 "API design patterns"

# Search within a specific collection
qmd search "API" -c notes

# Output as JSON for scripting
qmd query --json "quarterly reports"

# Output as markdown for LLM context
qmd search --md --full "error handling"

# Inspect how each result was scored
qmd query --json --explain "quarterly reports"

# Export all relevant file paths
qmd query "error handling" --all --files --min-score 0.4
```

## Document Reading

```sh
# View document table of contents (headings, bookmarks, slides)
qmd doc-toc paper.pdf
qmd doc-toc notes/readme.md

# Read content at specific addresses (from doc-toc or doc-grep)
qmd doc-read paper.pdf "line:45-120"
qmd doc-read paper.pdf "heading:Introduction" "heading:Methods"

# Search within a single document
qmd doc-grep paper.pdf "attention mechanism"
```

## Document Retrieval

```sh
# Get a single document by path
qmd get "meetings/2024-01-15.md"

# Get by docid (shown in search results)
qmd get "#abc123"

# Get document starting at line 50, max 100 lines
qmd get notes/meeting.md:50 -l 100

# Get multiple documents by glob pattern
qmd multi-get "journals/2025-05*.md"

# Get multiple by comma-separated list (supports docids)
qmd multi-get "doc1.md, doc2.md, #abc123"

# Limit multi-get to files under 20KB
qmd multi-get "docs/*.md" --max-bytes 20480

# Output multi-get as JSON
qmd multi-get "docs/*.md" --json
```

## Context Management

Context adds descriptive metadata to collections and paths, helping search understand your content. Context is returned alongside search results, giving agents better situational awareness.

```sh
# Add context to a collection (using qmd:// virtual paths)
qmd context add qmd://notes "Personal notes and ideas"
qmd context add qmd://docs/api "API documentation"

# Add context from within a collection directory
cd ~/notes && qmd context add "Personal notes and ideas"

# Add global context (applies to all collections)
qmd context add / "Knowledge base for my projects"

# List all contexts
qmd context list

# Remove context
qmd context rm qmd://notes/old
```

## Wiki (LLM Wiki Pattern)

QMD implements the [LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — a persistent, compounding knowledge base where an LLM incrementally builds and maintains interlinked wiki pages from raw source documents.

```sh
# Create a wiki collection
qmd collection add ~/wiki --name mywiki --type wiki

# Or mark an existing collection as wiki
qmd wiki init mywiki

# Analyze a source document for wiki page creation
qmd wiki ingest sources/paper.pdf --wiki mywiki

# Write a wiki page from stdin
echo '# Summary' | qmd wiki write mywiki concepts/topic.md
cat page.md | qmd wiki write mywiki concepts/topic.md --title "Topic Name"

# Health-check the wiki (orphans, broken links, missing pages)
qmd wiki lint

# View wiki activity log
qmd wiki log
qmd wiki log 2025-01-01

# Generate wiki index page
qmd wiki index mywiki
```

**Typical workflow:**

1. `qmd wiki ingest <source>` — analyze a source document, see related pages and suggestions
2. Write wiki pages with `qmd wiki write` or `doc_write` MCP tool (auto-logged)
3. `qmd wiki lint` — find orphans, broken links, and stale pages
4. `qmd wiki index <collection>` — regenerate the index page
5. `qmd search/query` — search across both raw sources and wiki pages

## Embedding

```sh
# Generate vector embeddings (900 tokens/chunk, 15% overlap)
qmd embed

# Force re-embed everything
qmd embed -f
```

## Maintenance

```sh
# Show index status and collection health
qmd status

# Re-index all collections
qmd update

# Re-index with git pull first (for remote repos)
qmd update --pull

# Clean up cache and orphaned data
qmd cleanup
```

## Options Reference

```sh
# Search & retrieval
-n <num>           # Number of results (default: 5, or 20 for --files/--json)
-c, --collection   # Restrict search to a specific collection
--all              # Return all matches (use with --min-score to filter)
--min-score <num>  # Minimum score threshold (default: 0)
--full             # Show full document content
--line-numbers     # Add line numbers to output
--explain          # Include retrieval score traces
--index <name>     # Use named index

# Output formats
--files            # Output: docid,score,filepath,context
--json             # JSON output with snippets
--csv              # CSV output
--md               # Markdown output
--xml              # XML output

# Get options
-l <num>           # Maximum lines to return
--from <num>       # Start from line number

# Multi-get options
-l <num>           # Maximum lines per file
--max-bytes <num>  # Skip files larger than N bytes (default: 10KB)
```

## Output Format

Default output is colorized CLI format (respects `NO_COLOR` env):

```
docs/guide.md:42 #a1b2c3
Title: Software Craftsmanship
Context: Work documentation
Score: 93%

This section covers the **craftsmanship** of building
quality software with attention to detail.
```

- **Path**: Collection-relative path (e.g., `docs/guide.md`)
- **Docid**: Short hash identifier (e.g., `#a1b2c3`) — use with `qmd get #a1b2c3`
- **Title**: Extracted from document (first heading or filename)
- **Context**: Path context if configured via `qmd context add`
- **Score**: Color-coded (green >70%, yellow >40%, dim otherwise)
- **Snippet**: Context around match with query terms highlighted
