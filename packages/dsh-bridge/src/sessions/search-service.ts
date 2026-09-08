import type { OperationAvailability } from "../../../runtime-facade/src/types.js";
import { BridgeCommandError } from "../controller-leases.js";

type SearchPort = {
  operationAvailability(capabilityId: string): OperationAvailability;
  search?(input: { query: string }, signal: AbortSignal): Promise<unknown>;
  history?(input: {
    sessionId: string;
    throughSeq: number;
    beforeSeq?: number;
    maxMessages?: number;
  }, signal?: AbortSignal): Promise<unknown>;
};

type CurrentResult =
  | { status: "current"; requestGeneration: number; value: unknown; cursor?: HistoryCursor }
  | { status: "superseded"; requestGeneration: number; cursor?: HistoryCursor };

type HistoryCursor = { throughSeq: number; beforeSeq?: number };

export function createSessionSearchService(options: { port: SearchPort }) {
  const { port } = options;
  let searchGeneration = 0;
  let searchAbort: AbortController | undefined;
  const histories = new Map<string, { generation: number; abort: AbortController }>();

  return {
    async search(query: string): Promise<CurrentResult> {
      requireOperation(port, "session.search", "search");
      searchAbort?.abort();
      const abort = new AbortController();
      searchAbort = abort;
      const requestGeneration = ++searchGeneration;
      const value = await port.search!({ query }, abort.signal);
      if (requestGeneration !== searchGeneration) {
        return { status: "superseded", requestGeneration };
      }
      return { status: "current", requestGeneration, value };
    },
    async history(input: {
      sessionId: string;
      throughSeq: number;
      beforeSeq?: number;
      maxMessages?: number;
    }): Promise<CurrentResult> {
      requireOperation(port, "session.history", "history");
      const previous = histories.get(input.sessionId);
      previous?.abort.abort();
      const abort = new AbortController();
      const requestGeneration = (previous?.generation ?? 0) + 1;
      histories.set(input.sessionId, { generation: requestGeneration, abort });
      const cursor: HistoryCursor = {
        throughSeq: input.throughSeq,
        ...(input.beforeSeq === undefined ? {} : { beforeSeq: input.beforeSeq }),
      };
      const value = await port.history!(input, abort.signal);
      if (histories.get(input.sessionId)?.generation !== requestGeneration) {
        return { status: "superseded", requestGeneration, cursor };
      }
      return { status: "current", requestGeneration, cursor, value };
    },
  };
}

function requireOperation(
  port: SearchPort,
  capabilityId: string,
  method: "search" | "history",
): void {
  if (!port.operationAvailability(capabilityId).available || !port[method]) {
    throw new BridgeCommandError("CAPABILITY_UNAVAILABLE", capabilityId);
  }
}
