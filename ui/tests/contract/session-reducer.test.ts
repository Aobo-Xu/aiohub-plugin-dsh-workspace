import { describe, expect, it } from "vitest";
import {
  acceptEvent,
  createContinuity,
  type SessionEventEnvelope,
} from "../../src/state/reducers/continuity";
import {
  hydrateFromSnapshot,
  prependHistoryPage,
  reduceSessionProjection,
  stableSerialize,
  type SessionProjection,
} from "../../src/state/reducers/session-reducer";
import {
  COLD_SNAPSHOT,
  FIXTURE_GENERATION,
  HISTORY_PAGE,
  liveEnvelope,
  replayScript,
} from "../fixtures/session-events";

function replayTwice(script: SessionEventEnvelope[]): [SessionProjection, SessionProjection] {
  const run = () => {
    const hydrated = hydrateFromSnapshot(COLD_SNAPSHOT);
    const continuity = createContinuity(FIXTURE_GENERATION, hydrated.cursor, hydrated.seq);
    let projection = hydrated.projection;
    for (const envelope of script) {
      if (acceptEvent(continuity, envelope) === "accepted") {
        projection = reduceSessionProjection(projection, envelope.event);
      }
    }
    return projection;
  };
  return [run(), run()];
}

describe("session continuity", () => {
  it("accepts the next in-order event and advances cursor/seq", () => {
    const continuity = createContinuity(FIXTURE_GENERATION, "cursor-4", 4);
    expect(acceptEvent(continuity, liveEnvelope())).toBe("accepted");
    expect(continuity.seq).toBe(5);
    expect(continuity.cursor).toBe("cursor-5");
  });

  it("rejects a duplicate event id", () => {
    const continuity = createContinuity(FIXTURE_GENERATION, "cursor-4", 4);
    expect(acceptEvent(continuity, liveEnvelope())).toBe("accepted");
    expect(acceptEvent(continuity, liveEnvelope())).toBe("duplicate");
  });

  it("rejects an older cursor as stale", () => {
    const continuity = createContinuity(FIXTURE_GENERATION, "cursor-5", 5);
    expect(acceptEvent(continuity, liveEnvelope({ eventId: "evt-old", seq: 4, cursor: "cursor-4" }))).toBe("stale");
  });

  it("requires resync on a sequence gap", () => {
    const continuity = createContinuity(FIXTURE_GENERATION, "cursor-4", 4);
    expect(acceptEvent(continuity, liveEnvelope({ eventId: "evt-9", seq: 7, cursor: "cursor-7" }))).toBe("resync-required");
  });

  it("requires resync on generation change", () => {
    const continuity = createContinuity(FIXTURE_GENERATION, "cursor-4", 4);
    expect(acceptEvent(continuity, liveEnvelope({ generationId: "gen-other" }))).toBe("resync-required");
  });

  it("forgets event ids beyond the bounded high-water window", () => {
    const continuity = createContinuity(FIXTURE_GENERATION, "cursor-4", 4);
    expect(acceptEvent(continuity, liveEnvelope())).toBe("accepted");
    for (let seq = 6; seq <= 600; seq += 1) {
      acceptEvent(continuity, liveEnvelope({ eventId: `evt-${seq}`, seq, cursor: `cursor-${seq}` }));
    }
    expect(continuity.recent.length).toBeLessThanOrEqual(512);
  });
});

describe("session projection reduction", () => {
  it("hydrates a cold snapshot into ordered turns with terminal status", () => {
    const { projection, cursor, seq } = hydrateFromSnapshot(COLD_SNAPSHOT);
    expect(cursor).toBe("cursor-4");
    expect(seq).toBe(4);
    expect(projection.sessionId).toBe("session-fixture-1");
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].turnId).toBe("turn-1");
    expect(projection.turns[0].status).toBe("completed");
    expect(projection.turns[0].events.map((event) => event.kind)).toEqual([
      "turn/start",
      "user/message",
      "assistant/message",
      "turn/completed",
    ]);
  });

  it("prepends a history page without duplicating snapshot facts", () => {
    const { projection } = hydrateFromSnapshot(COLD_SNAPSHOT);
    const older = prependHistoryPage(projection, HISTORY_PAGE);
    expect(older.turns.map((turn) => turn.turnId)).toEqual(["turn-0", "turn-1"]);
    const turnZero = older.turns[0];
    expect(turnZero.events.map((event) => event.kind)).toEqual(["turn/start", "user/message"]);
    expect(older.turns[1].events).toHaveLength(4);
  });

  it("keeps unknown additive event kinds inspectable", () => {
    const { projection } = hydrateFromSnapshot(COLD_SNAPSHOT);
    const next = reduceSessionProjection(projection, {
      kind: "future/feature",
      sessionId: "session-fixture-1",
      turnId: "turn-1",
      data: { novel: true },
    });
    expect(next.unknownKinds).toContain("future/feature");
    const turn = next.turns.find((candidate) => candidate.turnId === "turn-1");
    expect(turn?.events.at(-1)).toMatchObject({ kind: "future/feature", unknown: true });
  });

  it("does not mutate the input projection", () => {
    const { projection } = hydrateFromSnapshot(COLD_SNAPSHOT);
    const before = stableSerialize(projection);
    reduceSessionProjection(projection, {
      kind: "assistant/message",
      sessionId: "session-fixture-1",
      turnId: "turn-9",
      data: { text: "new" },
    });
    expect(stableSerialize(projection)).toBe(before);
  });

  it("replays the same fixture into byte-equivalent projections", () => {
    const [first, second] = replayTwice(replayScript());
    expect(stableSerialize(first)).toBe(stableSerialize(second));
    const turnTwo = first.turns.find((turn) => turn.turnId === "turn-2");
    expect(turnTwo?.status).toBe("completed");
  });
});
