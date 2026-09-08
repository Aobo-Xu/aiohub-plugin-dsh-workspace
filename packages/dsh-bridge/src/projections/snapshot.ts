import type { RuntimeEvent, SessionSnapshot } from "../../../runtime-facade/src/types.js";

type EventRecord = {
  type: string;
  event?: { type: string; seq: number; time: number; data: unknown };
};

type AuthoritativeSnapshotInput = {
  contractHash: string;
  domainGenerationId: string;
  sessionId: string;
  workspaceId?: string;
  adapterId: string;
  releaseCommit?: string;
  lineage?: { parentSessionId?: string; forkedAtSeq?: number };
  value: {
    header: { version: number; id: string; createdAt: number };
    cursor: number;
    records: readonly EventRecord[];
    hasMore: boolean;
  };
};

const DURABLE_KINDS = /^(?:turn\/(?:start|complete|error|cancelled|interrupted)|user\/message|assistant\/message|tool\/(?:call|result)|artifact\/|approval\/(?:asked|decided)|question\/(?:asked|answered)|terminal\/(?:opened|closed|exited)|job\/(?:started|completed|failed)|subagent\/(?:started|completed|failed))/;

export function createAuthoritativeSnapshot(
  input: AuthoritativeSnapshotInput,
): SessionSnapshot {
  const durableFacts: RuntimeEvent[] = [];
  for (const record of input.value.records) {
    const event = record.event;
    if (record.type !== "event" || event === undefined || !DURABLE_KINDS.test(event.type)) {
      continue;
    }
    const data = event.data;
    const turnId = typeof data === "object" && data !== null && "turnId" in data && typeof data.turnId === "string"
      ? data.turnId
      : undefined;
    durableFacts.push({
      kind: event.type,
      sessionId: input.sessionId,
      ...(turnId === undefined ? {} : { turnId }),
      data,
    });
  }

  if (durableFacts.length === 0) {
    throw new Error("DSH snapshot contains no durable facts");
  }

  return {
    contractHash: input.contractHash,
    source: "dsh",
    provenance: {
      adapterId: input.adapterId,
      ...(input.releaseCommit === undefined ? {} : { releaseCommit: input.releaseCommit }),
    },
    domainGenerationId: input.domainGenerationId,
    sessionId: input.sessionId,
    cursor: `cursor-${input.value.cursor}`,
    seq: input.value.cursor,
    durableFacts,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
  };
}
