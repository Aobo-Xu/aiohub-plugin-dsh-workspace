import { describe, expect, it } from "vitest";
import { buildCapsule, type CapsuleInput } from "../../src/side-chat/context-capsule";

const baseInput: CapsuleInput = {
  anchor: {
    kind: "selection",
    id: "turn-1#3#tool/call",
    sessionId: "session-1",
    turnId: "turn-1",
    excerpt: "shell: bun test",
  },
  summary: "Refactoring the auth module",
  goal: { text: "Ship the gate", revision: 2 },
  plan: "step 1, step 2",
  tasks: ["write tests", "fix lint"],
  nearbyTurns: [
    { turnId: "turn-1", status: "completed", summary: "first" },
    { turnId: "turn-2", status: "running", summary: "second" },
  ],
};

describe("context capsule", () => {
  it("carries exact anchor provenance identifying session and Turn", () => {
    const capsule = buildCapsule("session-1", baseInput, { mainStateRevision: "rev-10" });
    expect(capsule.anchor).toMatchObject({ id: "turn-1#3#tool/call", sessionId: "session-1", turnId: "turn-1" });
    expect(capsule.mainSessionId).toBe("session-1");
    expect(capsule.pinnedRevision).toBe("rev-10");
    expect(capsule.summaryAvailable).toBe(true);
    expect(capsule.reducedContextDisclosed).toBe(false);
  });

  it("discloses reduced context instead of fabricating a summary", () => {
    const { summary: _dropped, ...withoutSummary } = baseInput;
    const capsule = buildCapsule("session-1", withoutSummary, { mainStateRevision: "rev-11" });
    expect(capsule.summaryAvailable).toBe(false);
    expect(capsule.reducedContextDisclosed).toBe(true);
    const serialized = JSON.stringify(capsule);
    expect(serialized).not.toContain("Refactoring the auth module");
    // Goal/plan/tasks/nearby/anchor inputs remain.
    expect(serialized).toContain("Ship the gate");
    expect(serialized).toContain("turn-1");
  });

  it("bounds nearby Turns and records size contribution of explicit expansions", () => {
    const many = {
      ...baseInput,
      nearbyTurns: Array.from({ length: 9 }, (_, index) => ({
        turnId: `turn-${index}`,
        status: "completed",
        summary: `summary ${index}`,
      })),
      expansions: [{ id: "artifact-1", kind: "file", content: "line\n".repeat(10), bytes: 50 }],
    };
    const capsule = buildCapsule("session-1", many, { mainStateRevision: "rev-12" });
    const nearby = capsule.parts.filter((part) => part.kind === "nearby-turn");
    expect(nearby.length).toBeLessThanOrEqual(3);
    const expansion = capsule.parts.find((part) => part.kind === "expansion");
    expect(expansion).toBeDefined();
    expect(expansion?.bytes).toBeGreaterThan(0);
    expect(capsule.totalBytes).toBe(capsule.parts.reduce((sum, part) => sum + part.bytes, 0));
  });

  it("masks credential-like content and discloses that masking occurred", () => {
    const capsule = buildCapsule(
      "session-1",
      {
        ...baseInput,
        expansions: [
          { id: "env-1", kind: "file", content: 'apiKey = "sk-live-999"; note = "safe"', bytes: 40 },
        ],
      },
      { mainStateRevision: "rev-13" },
    );
    const serialized = JSON.stringify(capsule);
    expect(serialized).not.toContain("sk-live-999");
    expect(capsule.maskingApplied).toBe(true);
  });

  it("records prompt revision identity but never the System Prompt text", () => {
    const withPrompt = {
      ...baseInput,
      promptRevision: "prompt-rev-4",
      // Hostile extra field must never be copied into the capsule.
      systemPromptText: "FULL SECRET SYSTEM PROMPT",
    } as CapsuleInput & { systemPromptText: string };
    const capsule = buildCapsule("session-1", withPrompt, { mainStateRevision: "rev-14" });
    expect(capsule.promptRevision).toBe("prompt-rev-4");
    expect(JSON.stringify(capsule)).not.toContain("FULL SECRET SYSTEM PROMPT");
  });

  it("bounds oversized parts", () => {
    const capsule = buildCapsule(
      "session-1",
      { ...baseInput, plan: "p".repeat(50_000) },
      { mainStateRevision: "rev-15" },
    );
    const plan = capsule.parts.find((part) => part.kind === "plan");
    expect(plan?.content.length).toBeLessThanOrEqual(4200);
  });
});
