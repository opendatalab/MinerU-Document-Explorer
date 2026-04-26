/**
 * MCP Judge Tools — judge_claim.
 *
 * judge_claim: write-back LLM-judge tool. The agent reasons externally about
 * whether a claim is supported by source_text, then calls this tool to record
 * the verdict. The tool does NOT invoke an LLM; it validates and appends to log.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QMDStore } from "../../index.js";
import { appendLog } from "../../wiki/log.js";

// =============================================================================
// Input schema — exported for unit tests
// =============================================================================

export const judgeClaimInputSchema = {
  source_text: z.string().min(1).max(10_000).describe("The source text (snippet or full paragraph) the claim comes from"),
  claim: z.string().min(1).max(2000).describe("The specific factual claim being judged"),
  context: z.string().max(4000).optional().describe("Optional extra context (e.g. claim's role in a wiki page, neighboring claims)"),
  source_type: z.enum(["paper", "blog", "repo", "web", "wiki", "unknown"]).default("unknown").optional(),
  verdict: z.enum(["verified", "under_supported", "contradicted", "gaming", "unclear"]).optional().describe("Agent's verdict after reasoning; OMIT to get a prompt for how to judge"),
  reasoning: z.string().max(4000).optional().describe("Required when verdict is provided. Explains the verdict."),
  confidence: z.number().min(0).max(1).optional().describe("Required when verdict is provided. 0-1 confidence in the verdict."),
};

// =============================================================================
// Register judge tools
// =============================================================================

export function registerJudgeTools(server: McpServer, store: QMDStore): void {
  const db = store.internal.db;

  // ---------------------------------------------------------------------------
  // Tool: judge_claim
  // ---------------------------------------------------------------------------

  server.registerTool(
    "judge_claim",
    {
      title: "Judge Claim",
      description: "Write-back LLM-judge: agent supplies verdict after reasoning about whether a claim is supported by source_text. Returns JUDGE_INPUT_REQUIRED when verdict is omitted — use that as a cue to reason and retry.",
      annotations: { readOnlyHint: false },
      inputSchema: judgeClaimInputSchema,
    },
    async ({ source_text, claim, context, source_type, verdict, reasoning, confidence }) => {
      // No verdict provided — instruct agent to reason and retry
      if (verdict === undefined) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "JUDGE_INPUT_REQUIRED",
            hint: "Read source_text carefully, weigh the claim against it, then re-call judge_claim with verdict (one of: verified, under_supported, contradicted, gaming, unclear), reasoning (your explanation), and confidence (0–1).",
            claim,
          }) }],
          isError: true,
        };
      }

      // Verdict present but reasoning or confidence missing
      if (!reasoning || confidence === undefined) {
        const missing: string[] = [];
        if (!reasoning) missing.push("reasoning");
        if (confidence === undefined) missing.push("confidence");
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "JUDGE_INPUT_INCOMPLETE",
            hint: `Verdict was supplied but the following required fields are missing: ${missing.join(", ")}. Re-call with all three: verdict, reasoning, and confidence (0–1).`,
            missing,
          }) }],
          isError: true,
        };
      }

      // Append to log
      const timestamp = new Date().toISOString();
      try {
        appendLog(db, {
          operation: "judge_claim",
          details: {
            claim,
            source_type: source_type ?? "unknown",
            verdict,
            reasoning,
            confidence,
          },
        });
      } catch (e: unknown) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "LOG_APPEND_FAILED",
            message: e instanceof Error ? e.message : String(e),
          }) }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          logged: true,
          verdict,
          confidence,
          timestamp,
        }) }],
      };
    }
  );
}
