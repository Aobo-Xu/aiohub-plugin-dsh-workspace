import { describe, expect, it } from "vitest";
import { createContextSummary } from "../src/projections/context-summary.js";

describe("bounded DSH context summary", () => {
  it("keeps provenance and stale/omission metadata within the requested budget", () => {
    const summary = createContextSummary({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      source: "dsh",
      cursor: "cursor-4",
      stale: true,
      facts: [
        { kind: "user/message", text: "implement the feature" },
        { kind: "tool/result", text: "a very long result ".repeat(100) },
      ],
      maxChars: 180,
    });

    expect(summary.provenance).toMatchObject({ source: "dsh", cursor: "cursor-4" });
    expect(summary.stale).toBe(true);
    expect(summary.omittedFacts).toBeGreaterThan(0);
    expect(summary.text.length).toBeLessThanOrEqual(180);
  });
});
