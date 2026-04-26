import { describe, it, expect } from "vitest";
import { z } from "zod";
import { judgeClaimInputSchema } from "../src/mcp/tools/judge.js";

const judgeSchema = z.object(judgeClaimInputSchema);

describe("judge_claim input schema", () => {
  it("accepts minimal valid input (source_text + claim only)", () => {
    const r = judgeSchema.safeParse({ source_text: "Some source text.", claim: "A claim." });
    expect(r.success).toBe(true);
  });

  it("accepts full form with all optional fields", () => {
    const r = judgeSchema.safeParse({
      source_text: "The study found that X improves Y by 20%.",
      claim: "X improves Y.",
      verdict: "verified",
      reasoning: "The source directly states the improvement.",
      confidence: 0.92,
      source_type: "paper",
      context: "This claim appears in the introduction of a wiki page.",
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty source_text (min length 1)", () => {
    const r = judgeSchema.safeParse({ source_text: "", claim: "A claim." });
    expect(r.success).toBe(false);
  });

  it("rejects source_text over 10000 chars (max length)", () => {
    const r = judgeSchema.safeParse({ source_text: "a".repeat(10_001), claim: "A claim." });
    expect(r.success).toBe(false);
  });

  it("rejects source_text at exactly 10000 chars (boundary: valid)", () => {
    const r = judgeSchema.safeParse({ source_text: "a".repeat(10_000), claim: "A claim." });
    expect(r.success).toBe(true);
  });

  it("rejects empty claim (min length 1)", () => {
    const r = judgeSchema.safeParse({ source_text: "Some text.", claim: "" });
    expect(r.success).toBe(false);
  });

  it("rejects claim over 2000 chars (max length)", () => {
    const r = judgeSchema.safeParse({ source_text: "Some text.", claim: "a".repeat(2_001) });
    expect(r.success).toBe(false);
  });

  it("rejects unknown verdict enum value", () => {
    const r = judgeSchema.safeParse({ source_text: "x", claim: "y", verdict: "bogus" });
    expect(r.success).toBe(false);
  });

  it("rejects confidence below 0 (min 0)", () => {
    const r = judgeSchema.safeParse({ source_text: "x", claim: "y", confidence: -0.1 });
    expect(r.success).toBe(false);
  });

  it("rejects confidence above 1 (max 1)", () => {
    const r = judgeSchema.safeParse({ source_text: "x", claim: "y", confidence: 1.5 });
    expect(r.success).toBe(false);
  });

  it("rejects unknown source_type enum value", () => {
    const r = judgeSchema.safeParse({ source_text: "x", claim: "y", source_type: "invalid" });
    expect(r.success).toBe(false);
  });

  it("accepts all valid verdict enum values", () => {
    const verdicts = ["verified", "under_supported", "contradicted", "gaming", "unclear"] as const;
    for (const verdict of verdicts) {
      const r = judgeSchema.safeParse({ source_text: "x", claim: "y", verdict });
      expect(r.success, `verdict "${verdict}" should be valid`).toBe(true);
    }
  });

  it("accepts all valid source_type enum values", () => {
    const types = ["paper", "blog", "repo", "web", "unknown"] as const;
    for (const source_type of types) {
      const r = judgeSchema.safeParse({ source_text: "x", claim: "y", source_type });
      expect(r.success, `source_type "${source_type}" should be valid`).toBe(true);
    }
  });

  it("accepts confidence at boundary values 0 and 1", () => {
    const r0 = judgeSchema.safeParse({ source_text: "x", claim: "y", confidence: 0 });
    const r1 = judgeSchema.safeParse({ source_text: "x", claim: "y", confidence: 1 });
    expect(r0.success).toBe(true);
    expect(r1.success).toBe(true);
  });
});
