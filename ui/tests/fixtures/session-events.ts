/**
 * Deterministic replay fixture for session projection tests. The envelopes
 * model the Host wire shape (generation, cursor, monotonic seq, optional
 * event identity) without importing any DSH package.
 */
export const FIXTURE_GENERATION = "gen-fixture-1";
export const FIXTURE_SESSION = "session-fixture-1";

export type FixtureEnvelope = {
  generationId: string;
  eventId?: string;
  cursor: string;
  seq: number;
  event: { kind: string; sessionId?: string; turnId?: string; data: unknown };
};

export const SNAPSHOT_FACTS = [
  { kind: "turn/start", sessionId: FIXTURE_SESSION, turnId: "turn-1", data: { at: 1 } },
  { kind: "user/message", sessionId: FIXTURE_SESSION, turnId: "turn-1", data: { text: "hello" } },
  { kind: "assistant/message", sessionId: FIXTURE_SESSION, turnId: "turn-1", data: { text: "hi", source: { kind: "model", model: "m", provider: "p" } } },
  { kind: "turn/completed", sessionId: FIXTURE_SESSION, turnId: "turn-1", data: { at: 2 } },
];

export const COLD_SNAPSHOT = {
  domainGenerationId: FIXTURE_GENERATION,
  contractHash: "test-contract-hash",
  source: "dsh" as const,
  provenance: { adapterId: "fixture" },
  sessionId: FIXTURE_SESSION,
  cursor: "cursor-4",
  seq: 4,
  durableFacts: SNAPSHOT_FACTS,
};

export const HISTORY_PAGE = [
  { kind: "turn/start", sessionId: FIXTURE_SESSION, turnId: "turn-0", data: { at: 0 } },
  { kind: "user/message", sessionId: FIXTURE_SESSION, turnId: "turn-0", data: { text: "earlier" } },
  // Duplicate of a fact already in the snapshot; prepend must skip it.
  SNAPSHOT_FACTS[1],
];

export function liveEnvelope(overrides: Partial<FixtureEnvelope> = {}): FixtureEnvelope {
  return {
    generationId: FIXTURE_GENERATION,
    eventId: "evt-5",
    cursor: "cursor-5",
    seq: 5,
    event: {
      kind: "assistant/message",
      sessionId: FIXTURE_SESSION,
      turnId: "turn-2",
      data: { text: "live" },
    },
    ...overrides,
  };
}

export function replayScript(): FixtureEnvelope[] {
  return [
    liveEnvelope(),
    liveEnvelope({ eventId: "evt-6", cursor: "cursor-6", seq: 6, event: { kind: "turn/start", sessionId: FIXTURE_SESSION, turnId: "turn-2", data: { at: 3 } } }),
    liveEnvelope({ eventId: "evt-7", cursor: "cursor-7", seq: 7, event: { kind: "turn/completed", sessionId: FIXTURE_SESSION, turnId: "turn-2", data: { at: 4 } } }),
  ];
}
