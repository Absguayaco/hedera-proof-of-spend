import { describe, expect, it } from "vitest";
import { callerSuppliedCheckBudget, exitCodeFor, parseArgs, resolveMode } from "./buy.ts";

describe("parseArgs", () => {
  const ENV = {} as NodeJS.ProcessEnv;

  it("parses a full caller-supplied invocation", () => {
    const args = parseArgs(
      ["espresso", "--agent", "test-agent", "--verdict", "approved", "--rule", "rule-1", "--reason", "ok"],
      ENV,
    );

    expect(args).toEqual({
      slug: "espresso",
      agent: "test-agent",
      verdict: "approved",
      ruleId: "rule-1",
      reason: "ok",
      topicId: undefined,
    });
  });

  it("leaves verdict/ruleId/reason undefined for a headless-mode invocation (no --verdict at all)", () => {
    const args = parseArgs(["espresso", "--agent", "test-agent"], ENV);

    expect(args.verdict).toBeUndefined();
    expect(args.ruleId).toBeUndefined();
    expect(args.reason).toBeUndefined();
  });

  it("throws when the slug is missing", () => {
    expect(() => parseArgs(["--agent", "test-agent"], ENV)).toThrow(/Missing the menu slug/);
  });

  it("throws when --agent is missing", () => {
    expect(() => parseArgs(["espresso"], ENV)).toThrow(/Missing --agent/);
  });

  it('throws when --verdict is not "approved" or "declined"', () => {
    expect(() =>
      parseArgs(["espresso", "--agent", "a", "--verdict", "maybe", "--rule", "r"], ENV),
    ).toThrow(/--verdict must be "approved" or "declined"/);
  });

  it("throws when --verdict is given without --rule", () => {
    expect(() => parseArgs(["espresso", "--agent", "a", "--verdict", "declined"], ENV)).toThrow(
      /--verdict was given but --rule was not/,
    );
  });

  it("accepts --rule none as an explicit, valid rule id", () => {
    const args = parseArgs(["espresso", "--agent", "a", "--verdict", "declined", "--rule", "none"], ENV);

    expect(args.ruleId).toBe("none");
  });

  it("falls back to HCS_TOPIC_ID from the environment when --topic is not given", () => {
    const args = parseArgs(["espresso", "--agent", "a"], { HCS_TOPIC_ID: "0.0.777" } as NodeJS.ProcessEnv);

    expect(args.topicId).toBe("0.0.777");
  });

  it("prefers an explicit --topic over HCS_TOPIC_ID", () => {
    const args = parseArgs(
      ["espresso", "--agent", "a", "--topic", "0.0.111"],
      { HCS_TOPIC_ID: "0.0.777" } as NodeJS.ProcessEnv,
    );

    expect(args.topicId).toBe("0.0.111");
  });
});

describe("callerSuppliedCheckBudget", () => {
  it("returns exactly the supplied verdict/rule/reason, ignoring its own request argument", async () => {
    const checkBudget = callerSuppliedCheckBudget("declined", "rule-1", "over budget");

    const response = await checkBudget({ agent: "irrelevant", resource: "https://example.test/buy/anything" });

    expect(response).toEqual({ verdict: "declined", budgetRuleId: "rule-1", reason: "over budget" });
  });

  it("carries reason through as undefined when none was supplied", async () => {
    const checkBudget = callerSuppliedCheckBudget("approved", "none", undefined);

    const response = await checkBudget({ agent: "a", resource: "r" });

    expect(response).toEqual({ verdict: "approved", budgetRuleId: "none", reason: undefined });
  });
});

describe("resolveMode", () => {
  it("throws (refuses to buy) when neither an agent key nor a verdict is available", () => {
    expect(() => resolveMode(undefined, undefined)).toThrow(/Refusing to buy/);
  });

  it("resolves to headless whenever an agent key is present, regardless of verdict", () => {
    expect(resolveMode("key", undefined)).toBe("headless");
    expect(resolveMode("key", "approved")).toBe("headless");
    expect(resolveMode("key", "declined")).toBe("headless");
  });

  it("resolves to caller-supplied when a verdict is present and no agent key is", () => {
    expect(resolveMode(undefined, "approved")).toBe("caller-supplied");
    expect(resolveMode(undefined, "declined")).toBe("caller-supplied");
  });
});

describe("exitCodeFor", () => {
  it("is 1 for anchor_failed, regardless of filed", () => {
    expect(exitCodeFor("anchor_failed", false)).toBe(1);
    expect(exitCodeFor("anchor_failed", true)).toBe(1);
  });

  it("is 0 for declined, regardless of filed (nothing settled, so nothing to file)", () => {
    expect(exitCodeFor("declined", false)).toBe(0);
    expect(exitCodeFor("declined", true)).toBe(0);
  });

  it("is 0 for an approved purchase whose receipt was filed", () => {
    expect(exitCodeFor("approved", true)).toBe(0);
  });

  it("is 2 for an approved purchase whose receipt was NOT filed -- incomplete, not failed", () => {
    expect(exitCodeFor("approved", false)).toBe(2);
  });
});
