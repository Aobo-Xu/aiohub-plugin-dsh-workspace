import type { RuntimeEvent } from "../../../runtime-facade/src/types.js";
import type { Durability } from "../bounded-queue.js";

export type HostEventInput = RuntimeEvent & {
  generation: string;
  seq: number;
  eventId?: string;
  workspaceId?: string;
};

export type NormalizedHostEvent = HostEventInput & {
  eventId: string;
  durability: Durability;
};

const DURABLE_KIND = /^(?:turn\/(?:start|complete|error|cancelled|interrupted)|user\/message|assistant\/message|tool\/(?:call|result)|artifact\/|approval\/(?:asked|decided)|question\/(?:asked|answered)|terminal\/(?:opened|closed|exited)|job\/(?:started|completed|failed)|subagent\/(?:started|completed|failed))/;

export function normalizeHostEvents(events: readonly HostEventInput[]): NormalizedHostEvent[] {
  const generation = events[0]?.generation;
  if (generation !== undefined && events.some((event) => event.generation !== generation)) {
    throw new Error("EVENT_GENERATION_MISMATCH");
  }

  const sorted = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.seq - b.event.seq || a.index - b.index);
  const seen = new Set<string>();
  const normalized: NormalizedHostEvent[] = [];
  for (const { event } of sorted) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.generation.length === 0) {
      throw new Error("INVALID_HOST_EVENT");
    }
    const eventId = event.eventId ?? `${event.generation}:${event.seq}:${event.kind}`;
    if (seen.has(eventId)) continue;
    seen.add(eventId);
    normalized.push({
      ...event,
      eventId,
      durability: DURABLE_KIND.test(event.kind) ? "durable" : "disposable",
    });
  }
  return normalized;
}
