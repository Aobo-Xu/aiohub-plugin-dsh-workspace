import { describe, expect, it } from "vitest";
import { createAuthoritativeSnapshot } from "../src/projections/snapshot.js";

describe("authoritative DSH snapshot projection", () => {
  it("projects durable event records and preserves provenance", () => {
    const snapshot = createAuthoritativeSnapshot({
      contractHash: "contract-1",
      domainGenerationId: "generation-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      adapterId: "aiohub-dsh-rc1",
      value: {
        header: { version: 0, id: "session-1", createdAt: 1 },
        cursor: 4,
        records: [
          { type: "event", event: { type: "turn/start", seq: 1, time: 1, data: { turnId: "turn-1" } } },
          { type: "chunks", event: { type: "token-delta", seq: 2, time: 2, data: { text: "partial" } } },
          { type: "event", event: { type: "turn/complete", seq: 4, time: 4, data: { turnId: "turn-1" } } },
        ],
        hasMore: false,
      },
    });

    expect(snapshot).toMatchObject({
      source: "dsh",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      cursor: "cursor-4",
      seq: 4,
    });
    expect(snapshot.durableFacts.map((fact) => fact.kind)).toEqual([
      "turn/start",
      "turn/complete",
    ]);
    expect(snapshot.provenance).toMatchObject({ adapterId: "aiohub-dsh-rc1" });
  });
});
