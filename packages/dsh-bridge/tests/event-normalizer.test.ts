import { describe, expect, it } from "vitest";
import { normalizeHostEvents } from "../src/projections/event-normalizer.js";

describe("DSH event normalizer", () => {
  it("sorts by sequence, deduplicates identity, and classifies deltas", () => {
    const result = normalizeHostEvents([
      { generation: "generation-1", seq: 2, kind: "token-delta", data: { text: "b" } },
      { generation: "generation-1", seq: 1, kind: "turn/start", data: {} },
      { generation: "generation-1", seq: 2, kind: "token-delta", data: { text: "b" } },
      { generation: "generation-1", seq: 3, kind: "turn/complete", data: {} },
    ]);

    expect(result.map((event) => [event.seq, event.kind, event.durability])).toEqual([
      [1, "turn/start", "durable"],
      [2, "token-delta", "disposable"],
      [3, "turn/complete", "durable"],
    ]);
    expect(result.every((event) => event.sessionId === undefined || event.sessionId.length > 0)).toBe(true);
  });

  it("rejects mixed generations instead of merging incompatible streams", () => {
    expect(() => normalizeHostEvents([
      { generation: "generation-1", seq: 1, kind: "turn/start", data: {} },
      { generation: "generation-2", seq: 2, kind: "turn/complete", data: {} },
    ])).toThrowError("EVENT_GENERATION_MISMATCH");
  });
});
