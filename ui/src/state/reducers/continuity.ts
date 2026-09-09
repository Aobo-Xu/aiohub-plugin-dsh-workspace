import type { RuntimeEvent } from "@aiohub/dsh-runtime-facade/types";

/** Wire envelope the Host delivers for one session event. */
export type SessionEventEnvelope = {
  generationId: string;
  eventId?: string;
  cursor: string;
  seq: number;
  event: RuntimeEvent;
};

export type AcceptDecision = "accepted" | "duplicate" | "stale" | "resync-required";

export type Continuity = {
  generationId: string;
  cursor: string;
  seq: number;
  /** Bounded event-ID high-water window used for dedup. */
  recent: { eventId: string; seq: number }[];
};

export const RECENT_EVENT_WINDOW = 512;

export function createContinuity(generationId: string, cursor: string, seq: number): Continuity {
  return { generationId, cursor, seq, recent: [] };
}

/**
 * Decides whether an envelope continues the tracked stream. Only continuity
 * bookkeeping is mutated here; projections update through the pure reducer.
 */
export function acceptEvent(continuity: Continuity, envelope: SessionEventEnvelope): AcceptDecision {
  if (envelope.generationId !== continuity.generationId) {
    return "resync-required";
  }
  if (
    envelope.eventId !== undefined &&
    continuity.recent.some((entry) => entry.eventId === envelope.eventId)
  ) {
    return "duplicate";
  }
  if (envelope.seq <= continuity.seq) {
    return "stale";
  }
  if (envelope.seq > continuity.seq + 1) {
    return "resync-required";
  }

  continuity.seq = envelope.seq;
  continuity.cursor = envelope.cursor;
  if (envelope.eventId !== undefined) {
    continuity.recent.push({ eventId: envelope.eventId, seq: envelope.seq });
    if (continuity.recent.length > RECENT_EVENT_WINDOW) {
      continuity.recent.splice(0, continuity.recent.length - RECENT_EVENT_WINDOW);
    }
  }
  return "accepted";
}
