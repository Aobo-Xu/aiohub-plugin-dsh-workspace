import type { SessionSummary } from "../state/session-store";

export type SessionSearchStore = {
  state: { search: { generation: number; query: string; results: SessionSummary[] } | undefined };
  beginSearch(query: string): number;
  applySearchResults(generation: number, results: readonly SessionSummary[]): boolean;
};

export type SessionSearchDeps = {
  store: SessionSearchStore;
  runQuery(query: string, signal: AbortSignal): Promise<readonly SessionSummary[]>;
};

export type SessionSearchOutcome =
  | { ok: true }
  | { ok: false; reason: { code: "STALE_GENERATION" | "SEARCH_FAILED"; message?: string } };

/**
 * Cancellable, generation-ordered global session search. An older query can
 * never overwrite a newer projection: the store compares generations, and the
 * obsolete in-flight request is aborted as a best-effort cleanup.
 */
export function useSessionSearch(deps: SessionSearchDeps) {
  let active: AbortController | undefined;

  async function submit(query: string): Promise<SessionSearchOutcome> {
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const generation = deps.store.beginSearch(query);
    try {
      const results = await deps.runQuery(query, controller.signal);
      const applied = deps.store.applySearchResults(generation, results);
      return applied ? { ok: true } : { ok: false, reason: { code: "STALE_GENERATION" } };
    } catch (error) {
      if (deps.store.state.search?.generation === generation) {
        // Keep the current query visible with empty results; never leave a
        // previous generation's hits behind.
        deps.store.applySearchResults(generation, []);
      }
      return {
        ok: false,
        reason: { code: "SEARCH_FAILED", message: (error as Error | undefined)?.message },
      };
    }
  }

  function cancel(): void {
    active?.abort();
    active = undefined;
  }

  return { submit, cancel };
}
