/**
 * doc-reading-config.ts — pluggable provider config for multi-format document reading.
 *
 * Each capability (fullText, toc, elements) declares a providers array
 * in priority order. The first available/succeeding provider wins;
 * the rest act as fallbacks.
 *
 * Config is loaded from (first match wins):
 *   1. MINERU_API_KEY env var (injects into mineru credential slot)
 *   2. ~/.config/qmd/doc-reading.json
 *   3. ./qmd.config.json (cwd)
 *
 * Example qmd.config.json:
 * {
 *   "docReading": {
 *     "providers": {
 *       "fullText": { "pdf": ["mineru_cloud", "pymupdf"] },
 *       "toc":      { "pdf": ["native_bookmarks", "gpt_pageindex"] },
 *       "elements": { "pdf": ["mineru_agentic_ocr"], "docx": ["python_docx_local"], "pptx": ["python_pptx_local"] }
 *     },
 *     "credentials": {
 *       "mineru": { "api_key": "...", "api_url": "https://mineru.net/api/v4" }
 *     }
 *   }
 * }
 *
 * Defaults (no config file needed):
 *   fullText.pdf  → ["pymupdf"]
 *   toc.pdf       → ["native_bookmarks"]
 *   elements.pdf  → []   (returns empty — no local PDF element extraction yet)
 *   elements.docx → ["python_docx_local"]
 *   elements.pptx → ["python_pptx_local"]
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Provider name literals
// ---------------------------------------------------------------------------

export type FullTextProvider =
  | "mineru_cloud"   // MinerU cloud API via mineru-open-sdk (high quality, requires api_key)
  | "mineru_local"   // MinerU VLM local model via mineru-vl-utils[transformers] (requires model_path)
  | "pymupdf";       // PyMuPDF native text extraction (fast, poor on scanned docs)

export type TocProvider =
  | "native_bookmarks"    // PyMuPDF: extract embedded PDF bookmarks (fast, local)
  | "gpt_pageindex"       // GPT PageIndex: LLM-inferred TOC via OpenAI-compatible API + Explorer PageIndex script
  | "mineru_pageindex";   // MinerU PageIndex: LLM-inferred TOC (requires api_key) 🚧

export type ElementsProvider =
  | "mineru_agentic_ocr"  // MinerU AgenticOCR cloud (PDF tables/figures/equations) 🚧
  | "python_docx_local"   // python-docx local table extraction (Docx)
  | "python_pptx_local";  // python-pptx local table extraction (PPTX)

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  fullText?: {
    pdf?: FullTextProvider[];
    // docx and pptx use fixed python-docx/python-pptx; no provider selection needed
  };
  toc?: {
    pdf?: TocProvider[];
  };
  elements?: {
    pdf?: ElementsProvider[];
    docx?: ElementsProvider[];
    pptx?: ElementsProvider[];
  };
}

export interface Credentials {
  mineru?: {
    api_key: string;
    api_url?: string;  // default: "https://mineru.net/api/v4"
  };
  openai?: {
    api_key: string;
    base_url?: string;  // default: "https://api.openai.com/v1"
    model?: string;     // default: "gpt-4o-2024-11-20"
  };
}

export interface LocalModelConfig {
  /** Path to MinerU2.5 model dir, e.g. "~/.cache/mineru/MinerU2.5-2509-1.2B" */
  model_path: string;
  /** Rendering DPI for PDF→image conversion (default: 150) */
  dpi?: number;
}

export interface DocReadingConfig {
  providers?: ProviderConfig;
  credentials?: Credentials;
  local?: LocalModelConfig;
}

// ---------------------------------------------------------------------------
// Defaults (used when config is absent or partial)
// ---------------------------------------------------------------------------

export const DEFAULT_PROVIDERS: Required<ProviderConfig> = {
  fullText: { pdf: ["pymupdf"] },
  toc:      { pdf: ["native_bookmarks"] },
  elements: { pdf: [], docx: ["python_docx_local"], pptx: ["python_pptx_local"] },
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

let _cached: DocReadingConfig | undefined = undefined;

function loadFromFile(filePath: string): DocReadingConfig | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    // Support both { docReading: {...} } wrapper and bare object
    const cfg = raw.docReading ?? raw;
    return cfg as DocReadingConfig;
  } catch {
    return null;
  }
}

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const ov = override[key];
    const bs = base[key];
    if (ov && typeof ov === "object" && !Array.isArray(ov) && bs && typeof bs === "object") {
      result[key] = deepMerge(bs as object, ov as object) as T[typeof key];
    } else if (ov !== undefined) {
      result[key] = ov as T[typeof key];
    }
  }
  return result;
}

/** Load and cache the docReading config. Call resetDocReadingConfig() to clear. */
export function getDocReadingConfig(): DocReadingConfig {
  if (_cached !== undefined) return _cached;

  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const homeConfigPath = join(xdgConfig, "qmd", "doc-reading.json");
  const cwdConfigPath  = resolve(process.cwd(), "qmd.config.json");

  let merged: DocReadingConfig = {};
  const fromHome = loadFromFile(homeConfigPath);
  const fromCwd  = loadFromFile(cwdConfigPath);

  if (fromHome) merged = deepMerge(merged, fromHome);
  if (fromCwd)  merged = deepMerge(merged, fromCwd);

  // Env var: inject MINERU_API_KEY into credentials
  const envKey = process.env.MINERU_API_KEY;
  if (envKey) {
    merged.credentials = deepMerge(merged.credentials ?? {}, {
      mineru: { api_key: envKey },
    });
  }

  // Env var: inject OPENAI_API_KEY / OPENAI_BASE_URL into credentials
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    const openaiOverride: { api_key: string; base_url?: string } = { api_key: openaiKey };
    if (process.env.OPENAI_BASE_URL) openaiOverride.base_url = process.env.OPENAI_BASE_URL;
    merged.credentials = deepMerge(merged.credentials ?? {}, {
      openai: openaiOverride,
    });
  }

  _cached = merged;
  return _cached;
}

/** Clear cached config (useful in tests or after writing new config). */
export function resetDocReadingConfig(): void {
  _cached = undefined;
}

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

/** Resolved provider list for a capability+format, with defaults applied. */
export function getProviders(
  capability: "fullText" | "toc" | "elements",
  format: "pdf" | "docx" | "pptx"
): string[] {
  const cfg = getDocReadingConfig();
  const userProviders = cfg.providers?.[capability]?.[format as keyof ProviderConfig[typeof capability]];
  if (userProviders) return userProviders as string[];

  const defaultList = (DEFAULT_PROVIDERS[capability][format as keyof ProviderConfig[typeof capability]] ?? []) as string[];

  // Smart default: when MinerU credentials are available and no explicit config,
  // auto-prepend mineru_cloud for PDF fullText extraction.
  if (capability === "fullText" && format === "pdf" && cfg.credentials?.mineru?.api_key) {
    if (!defaultList.includes("mineru_cloud")) {
      return ["mineru_cloud", ...defaultList];
    }
  }

  return defaultList;
}

/** MinerU credentials from config, or null if not configured. */
export function getMinerUCredentials(): { api_key: string; api_url: string } | null {
  const creds = getDocReadingConfig().credentials?.mineru;
  if (!creds?.api_key) return null;
  return {
    api_key: creds.api_key,
    api_url: creds.api_url ?? "https://mineru.net/api/v4",
  };
}

/** Local model config, or null if not configured. */
export function getLocalModelConfig(): { model_path: string; dpi: number } | null {
  const local = getDocReadingConfig().local;
  if (!local?.model_path) return null;
  return {
    model_path: local.model_path.replace(/^~/, process.env.HOME ?? ""),
    dpi: local.dpi ?? 150,
  };
}

/** Returns true if the given provider is in the resolved provider list. */
export function hasProvider(
  capability: "fullText" | "toc" | "elements",
  format: "pdf" | "docx" | "pptx",
  provider: string
): boolean {
  return getProviders(capability, format).includes(provider);
}

/** OpenAI-compatible credentials for GPT PageIndex, or null if not configured. */
export function getOpenAICredentials(): { api_key: string; base_url: string; model: string } | null {
  const creds = getDocReadingConfig().credentials?.openai;
  if (!creds?.api_key) return null;
  return {
    api_key: creds.api_key,
    base_url: creds.base_url ?? "https://api.openai.com/v1",
    model: creds.model ?? "gpt-4o-2024-11-20",
  };
}
