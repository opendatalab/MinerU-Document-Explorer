/**
 * CLI UX Improvement Tests
 *
 * Tests for improved error messages, --full flag, and other UX fixes.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

let testDir: string;
let testDbPath: string;
let testConfigDir: string;
let fixturesDir: string;

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const tsxBin = (() => {
  const candidate = join(projectRoot, "node_modules", ".bin", "tsx");
  if (existsSync(candidate)) return candidate;
  return join(process.cwd(), "node_modules", ".bin", "tsx");
})();

async function runQmd(
  args: string[],
  options: { cwd?: string; stdin?: string } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const workingDir = options.cwd || fixturesDir;
  const proc = spawn(tsxBin, [qmdScript, ...args], {
    cwd: workingDir,
    env: {
      ...process.env,
      INDEX_PATH: testDbPath,
      QMD_CONFIG_DIR: testConfigDir,
      PWD: workingDir,
    },
    stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
  });

  if (options.stdin) {
    proc.stdin!.write(options.stdin);
    proc.stdin!.end();
  }

  const stdoutPromise = new Promise<string>((resolve, reject) => {
    let data = "";
    proc.stdout?.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    proc.once("error", reject);
    proc.stdout?.once("end", () => resolve(data));
  });
  const stderrPromise = new Promise<string>((resolve, reject) => {
    let data = "";
    proc.stderr?.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    proc.once("error", reject);
    proc.stderr?.once("end", () => resolve(data));
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });

  return { stdout: await stdoutPromise, stderr: await stderrPromise, exitCode };
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-ux-test-"));
  testDbPath = join(testDir, "test.sqlite");
  testConfigDir = join(testDir, "config");
  fixturesDir = join(testDir, "fixtures");

  await mkdir(testConfigDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });
  await mkdir(join(fixturesDir, "notes"), { recursive: true });

  await writeFile(join(testConfigDir, "index.yml"), "collections: {}\n");

  await writeFile(
    join(fixturesDir, "api-design-principles.md"),
    `# API Design Principles

## Introduction

Good API design is crucial for developer experience.

## Principle 1: Use Nouns

URLs should represent resources, not actions.

## Principle 2: Use Plural Nouns

Always use plural nouns for consistency.

## Principle 3: Versioning

Always version your APIs.

## Conclusion

Follow these principles for better APIs.
`
  );

  await writeFile(
    join(fixturesDir, "notes", "meeting-notes.md"),
    `# Weekly Meeting Notes

Date: 2024-03-15

## Attendees
- Alice (Engineering Lead)
- Bob (Product Manager)
- Charlie (Designer)

## Discussion
- Reviewed API design feedback
- Discussed timeline for Q2 launch
- Performance optimization priorities

## Action Items
1. Alice to draft API versioning proposal
2. Bob to share Q2 roadmap
3. Charlie to present new mockups
`
  );

  await writeFile(
    join(fixturesDir, "notes", "architecture-overview.md"),
    `# Architecture Overview

## System Components
- Frontend: React SPA
- Backend: Node.js + Express
- Database: PostgreSQL
- Cache: Redis
- Search: Elasticsearch

## Data Flow
User requests flow through the API gateway to microservices.

## Deployment
All services deployed on Kubernetes.
`
  );

  await runQmd(["collection", "add", ".", "--name", "testdocs"]);
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("--full flag in CLI search output", () => {
  test("search without --full shows snippet (short output)", async () => {
    const { stdout, exitCode } = await runQmd(["search", "API design"]);
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBeLessThan(30);
  });

  test("search with --full shows complete document content", async () => {
    const { stdout, exitCode } = await runQmd(["search", "API design", "--full"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Principle 1");
    expect(stdout).toContain("Principle 2");
    expect(stdout).toContain("Principle 3");
    expect(stdout).toContain("Conclusion");
  });

  test("search --full --json returns body instead of snippet", async () => {
    const { stdout, exitCode } = await runQmd(["search", "API design", "--full", "--json"]);
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].body).toBeDefined();
    expect(results[0].snippet).toBeUndefined();
    expect(results[0].body).toContain("Conclusion");
  });

  test("search --full --md shows full content in markdown format", async () => {
    const { stdout, exitCode } = await runQmd(["search", "API design", "--full", "--md"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Conclusion");
    expect(stdout).toContain("Principle 3");
  });
});

describe("Document not found suggests similar paths", () => {
  test("partial filename match suggests similar documents", async () => {
    const { stderr, exitCode } = await runQmd(["get", "api-design"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Document not found");
    expect(stderr).toContain("Did you mean");
    expect(stderr).toContain("api-design-principles.md");
  });

  test("typo in path suggests correct document", async () => {
    const { stderr, exitCode } = await runQmd(["get", "meeting-note"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Document not found");
    expect(stderr).toContain("Did you mean");
    expect(stderr).toContain("meeting-notes.md");
  });

  test("completely wrong path shows no suggestions", async () => {
    const { stderr, exitCode } = await runQmd(["get", "zzzzzzzzzzzzzzzzz"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Document not found");
    expect(stderr).not.toContain("Did you mean");
  });
});

describe("Collection not found lists available collections", () => {
  test("wrong collection name shows available ones", async () => {
    const { stderr, exitCode } = await runQmd(["search", "test", "-c", "nonexistent"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection not found: nonexistent");
    expect(stderr).toContain("Available collections:");
    expect(stderr).toContain("testdocs");
  });
});

describe("Embedded skill sync", () => {
  test("skill show displays current version", async () => {
    const { stdout, exitCode } = await runQmd(["skill", "show"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("3.3.0");
    expect(stdout).toContain("MinerU Document Explorer");
  });
});
