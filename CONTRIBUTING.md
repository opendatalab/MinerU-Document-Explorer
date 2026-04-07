# Contributing to MinerU Document Explorer

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

```bash
git clone https://github.com/opendatalab/MinerU-Document-Explorer.git
cd MinerU-Document-Explorer
bun install
bun link          # Makes `qmd` available globally
```

### Prerequisites

- **Node.js** >= 22 or **Bun** (latest)
- **Python 3** with `pymupdf` (for PDF support), `python-docx` (for DOCX), `python-pptx` (for PPTX)
- **SQLite** development headers (`libsqlite3-dev` on Ubuntu, `brew install sqlite` on macOS)

### Running from Source

```bash
bun src/cli/qmd.ts <command>     # Run CLI directly
bun run build                     # Compile TypeScript to dist/
```

### Running Tests

```bash
# Full test suite
npx vitest run --reporter=verbose test/

# Single test file
npx vitest run test/store.test.ts

# With Bun
bun test --preload ./src/test-preload.ts test/
```

## Project Structure

```
src/
├── index.ts          # SDK public API
├── store.ts          # Core data access, indexing, document retrieval
├── search.ts         # FTS (BM25), vector search, query expansion, reranking
├── hybrid-search.ts  # Hybrid query orchestration
├── chunking.ts       # Markdown-aware smart chunking
├── llm.ts            # node-llama-cpp integration (embed, rerank, generate)
├── db.ts             # Cross-runtime SQLite layer
├── backends/         # Multi-format document backends (PDF, DOCX, PPTX, Markdown)
├── mcp/              # MCP server and tools
├── wiki/             # Wiki lifecycle (log, lint, index generation)
└── cli/              # CLI entry point and formatters
```

See `CLAUDE.md` for a detailed module breakdown.

## How to Contribute

### Reporting Issues

- Use [GitHub Issues](https://github.com/opendatalab/MinerU-Document-Explorer/issues)
- Include your OS, Node/Bun version, and steps to reproduce
- For search quality issues, include the query, expected results, and actual results

### Pull Requests

1. Fork the repository and create a branch from `main`
2. Make your changes with clear, focused commits
3. Add or update tests for any changed functionality
4. Ensure all tests pass: `npx vitest run test/`
5. Update `CHANGELOG.md` under `## [Unreleased]` if applicable
6. Open a PR with a clear description of what and why

### Code Style

- TypeScript with strict mode
- Use Bun-compatible APIs where possible
- Avoid comments that just narrate what code does — comments should explain *why*
- Keep functions focused; avoid god modules

### Areas Where Help is Welcome

- **New document backends** — support for additional formats (EPUB, HTML, etc.)
- **Search quality** — better query expansion prompts, chunking strategies
- **Performance** — indexing speed, memory usage, startup time
- **Documentation** — tutorials, examples, translations
- **MCP ecosystem** — integration guides for different AI agents

## Important Notes

- **Never run `qmd collection add`, `qmd embed`, or `qmd update` in CI** — these modify the index
- **Never run `bun build --compile`** — it overwrites the shell wrapper and breaks sqlite-vec
- The `qmd` binary in `bin/` is a shell script that runs compiled JS from `dist/`
- Index is stored at `~/.cache/qmd/index.sqlite`

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
