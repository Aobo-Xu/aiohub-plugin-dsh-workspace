import { reactive } from "vue";
import type { ControllerLease, SessionSnapshot } from "@aiohub/dsh-runtime-facade/types";
import {
  acceptEvent,
  createContinuity,
  type AcceptDecision,
  type Continuity,
  type SessionEventEnvelope,
} from "./reducers/continuity";
import {
  hydrateFromSnapshot,
  reduceSessionProjection,
  type SessionProjection,
} from "./reducers/session-reducer";

export type SessionSummary = {
  id: string;
  title: string;
  workspaceId?: string;
  archived?: boolean;
  updatedAt?: string;
};

export type OpenSessionState = {
  continuity: Continuity;
  needsResync: boolean;
  lease: ControllerLease | undefined;
};

export type SessionStoreState = {
  sessions: SessionSummary[];
  search: { generation: number; query: string; results: SessionSummary[] } | undefined;
  open: Record<string, OpenSessionState>;
};

/**
 * Session catalog and open-session projections. Projections are rebuilt
 * from snapshots and extended through continuity-checked events only.
 */
export function createSessionStore() {
  const state = reactive<SessionStoreState>({
    sessions: [],
    search: undefined,
    open: {},
  });
  const projections = reactive<Record<string, SessionProjection>>({});
  let searchGeneration = 0;

  function hydrate(snapshot: SessionSnapshot): void {
    const { projection, cursor, seq } = hydrateFromSnapshot(snapshot);
    projections[snapshot.sessionId] = projection;
    state.open[snapshot.sessionId] = {
      continuity: createContinuity(snapshot.domainGenerationId, cursor, seq),
      needsResync: false,
      lease: state.open[snapshot.sessionId]?.lease,
    };
  }

  function applyEnvelope(envelope: SessionEventEnvelope): AcceptDecision {
    const sessionId = envelope.event.sessionId;
    if (sessionId === undefined) {
      return "stale";
    }
    const open = state.open[sessionId];
    const projection = projections[sessionId];
    if (open === undefined || projection === undefined) {
      return "resync-required";
    }
    const decision = acceptEvent(open.continuity, envelope);
    if (decision === "accepted") {
      projections[sessionId] = reduceSessionProjection(projection, envelope.event);
    } else if (decision === "resync-required") {
      open.needsResync = true;
    }
    return decision;
  }

  function replaceProjection(sessionId: string, projection: SessionProjection): void {
    projections[sessionId] = projection;
  }

  function applyLease(sessionId: string, lease: ControllerLease | undefined): void {
    const open = state.open[sessionId];
    if (open !== undefined) {
      open.lease = lease;
    }
  }

  function close(sessionId: string): void {
    delete state.open[sessionId];
    delete projections[sessionId];
  }

  function replaceCatalog(sessions: readonly SessionSummary[]): void {
    state.sessions = [...sessions];
  }

  function beginSearch(query: string): number {
    searchGeneration += 1;
    state.search = { generation: searchGeneration, query, results: [] };
    return searchGeneration;
  }

  /** Stale generations never overwrite the current search projection. */
  function applySearchResults(generation: number, results: readonly SessionSummary[]): boolean {
    if (state.search === undefined || generation !== state.search.generation) {
      return false;
    }
    state.search.results = [...results];
    return true;
  }

  return {
    state,
    openProjections: projections,
    hydrate,
    applyEnvelope,
    replaceProjection,
    applyLease,
    close,
    replaceCatalog,
    beginSearch,
    applySearchResults,
  };
}
