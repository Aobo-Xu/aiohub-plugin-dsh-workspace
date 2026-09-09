import type { RuntimeEvent, SessionSnapshot } from "@aiohub/dsh-runtime-facade/types";

export type TurnStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ProjectedEvent = {
  kind: string;
  turnId?: string;
  sessionId?: string;
  data: unknown;
  /** True for additive kinds the reducer does not model; UI masks them. */
  unknown?: boolean;
};

export type TurnProjection = {
  turnId: string;
  status: TurnStatus;
  events: ProjectedEvent[];
};

export type SessionProjection = {
  sessionId: string;
  turns: TurnProjection[];
  /** Events that carry no turn identity, in arrival order. */
  orphanEvents: ProjectedEvent[];
  /** Additive kinds seen so far, for the masked generic presenter. */
  unknownKinds: string[];
};

/** Presenter families the reducer models structurally. */
const KNOWN_KIND_PREFIXES = [
  "turn/",
  "user/",
  "assistant/",
  "reasoning/",
  "tool/",
  "job/",
  "workflow/",
  "context/",
  "file/",
  "diff/",
  "terminal/",
  "subagent/",
];

const TERMINAL_STATUS: Readonly<Record<string, TurnStatus>> = {
  "turn/start": "running",
  "turn/completed": "completed",
  "turn/failed": "failed",
  "turn/cancelled": "cancelled",
  "turn/interrupted": "interrupted",
};

export function createEmptyProjection(sessionId: string): SessionProjection {
  return { sessionId, turns: [], orphanEvents: [], unknownKinds: [] };
}

export function hydrateFromSnapshot(snapshot: SessionSnapshot): {
  projection: SessionProjection;
  cursor: string;
  seq: number;
} {
  let projection = createEmptyProjection(snapshot.sessionId);
  for (const fact of snapshot.durableFacts) {
    projection = reduceSessionProjection(projection, fact);
  }
  return { projection, cursor: snapshot.cursor, seq: snapshot.seq };
}

/**
 * Prepends an older history page. Facts already present (snapshot overlap)
 * are skipped by structural identity, never re-applied.
 */
export function prependHistoryPage(
  projection: SessionProjection,
  facts: readonly RuntimeEvent[],
): SessionProjection {
  let next = projection;
  const existing = collectFactKeys(projection);
  const additions: RuntimeEvent[] = [];
  for (const fact of facts) {
    const key = factKey(fact);
    if (!existing.has(key)) {
      additions.push(fact);
      existing.add(key);
    }
  }
  if (additions.length === 0) {
    return projection;
  }
  let older = createEmptyProjection(projection.sessionId);
  for (const fact of additions) {
    older = reduceSessionProjection(older, fact);
  }
  return mergePrepend(older, next);
}

/**
 * Pure reduction of one accepted event into the projection. The input is
 * never mutated; deterministic for the same (projection, event) pair.
 */
export function reduceSessionProjection(
  projection: SessionProjection,
  event: RuntimeEvent,
): SessionProjection {
  const projected = toProjectedEvent(event);
  const unknownKinds = projected.unknown
    ? projection.unknownKinds.includes(projected.kind)
      ? projection.unknownKinds
      : [...projection.unknownKinds, projected.kind]
    : projection.unknownKinds;

  if (projected.turnId === undefined) {
    return { ...projection, orphanEvents: [...projection.orphanEvents, projected], unknownKinds };
  }

  const turnId = projected.turnId;
  const index = projection.turns.findIndex((turn) => turn.turnId === turnId);
  if (index === -1) {
    const status = TERMINAL_STATUS[projected.kind] ?? "running";
    return {
      ...projection,
      turns: [...projection.turns, { turnId, status, events: [projected] }],
      unknownKinds,
    };
  }

  const turn = projection.turns[index];
  const status = TERMINAL_STATUS[projected.kind] ?? turn.status;
  const turns = projection.turns.slice();
  turns[index] = { ...turn, status, events: [...turn.events, projected] };
  return { ...projection, turns, unknownKinds };
}

/** Stable JSON serialization with sorted keys for byte-equivalent replay checks. */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function toProjectedEvent(event: RuntimeEvent): ProjectedEvent {
  const unknown = !KNOWN_KIND_PREFIXES.some((prefix) => event.kind.startsWith(prefix));
  return {
    kind: event.kind,
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    data: event.data,
    ...(unknown ? { unknown: true as const } : {}),
  };
}

function factKey(fact: RuntimeEvent): string {
  return `${fact.kind}|${fact.turnId ?? ""}|${stableSerialize(fact.data)}`;
}

function collectFactKeys(projection: SessionProjection): Set<string> {
  const keys = new Set<string>();
  for (const turn of projection.turns) {
    for (const event of turn.events) {
      keys.add(`${event.kind}|${event.turnId ?? ""}|${stableSerialize(event.data)}`);
    }
  }
  for (const event of projection.orphanEvents) {
    keys.add(`${event.kind}|${event.turnId ?? ""}|${stableSerialize(event.data)}`);
  }
  return keys;
}

function mergePrepend(older: SessionProjection, current: SessionProjection): SessionProjection {
  const turnIds = new Set(older.turns.map((turn) => turn.turnId));
  const tail = current.turns.filter((turn) => !turnIds.has(turn.turnId));
  return {
    sessionId: current.sessionId,
    turns: [...older.turns, ...tail],
    orphanEvents: [...older.orphanEvents, ...current.orphanEvents],
    unknownKinds: [...new Set([...older.unknownKinds, ...current.unknownKinds])],
  };
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortDeep(record[key]);
    }
    return sorted;
  }
  return value;
}
