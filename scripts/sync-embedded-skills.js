#!/usr/bin/env node
/**
 * Regenerate src/embedded-skills.ts from skills/mineru-document-explorer/ source files.
 * Run automatically during `npm run build` to prevent drift.
 */
import { readFileSync, writeFileSync } from "fs";

const files = {
  "SKILL.md": "skills/mineru-document-explorer/SKILL.md",
  "references/mcp-setup.md": "skills/mineru-document-explorer/references/mcp-setup.md",
};

const entries = Object.entries(files).map(([key, path]) => {
  const content = readFileSync(path, "utf8");
  const b64 = Buffer.from(content).toString("base64");
  return `  "${key}": "${b64}"`;
});

const output = `// Auto-generated — do not edit manually. Run: node scripts/sync-embedded-skills.js

export type EmbeddedSkillFile = {
  relativePath: string;
  content: string;
};

const EMBEDDED_QMD_SKILL_BASE64: Record<string, string> = {
${entries.join(",\n")}
};

export function getEmbeddedQmdSkillFiles(): EmbeddedSkillFile[] {
  return Object.entries(EMBEDDED_QMD_SKILL_BASE64).map(([relativePath, encoded]) => ({
    relativePath,
    content: Buffer.from(encoded, 'base64').toString('utf8'),
  }));
}

export function getEmbeddedQmdSkillContent(): string {
  return Buffer.from(EMBEDDED_QMD_SKILL_BASE64["SKILL.md"]!, "base64").toString("utf8");
}
`;

writeFileSync("src/embedded-skills.ts", output, "utf8");
console.log("Synced embedded-skills.ts from skills/mineru-document-explorer/");
