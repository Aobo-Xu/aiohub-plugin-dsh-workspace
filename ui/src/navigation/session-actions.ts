import type { ControllerLease } from "@aiohub/dsh-runtime-facade/types";
import {
  getActionAvailability,
  type ActionContext,
} from "../facade/capability-selectors";

export type SessionSummaryLike = { id: string; title: string };

/**
 * Host-owned catalog mutations are applied only after a confirmed success;
 * a Host rejection or transport failure must leave projections and drafts
 * untouched.
 */
export type SessionActionCatalog = {
  remove(sessionId: string): void;
  applyRename(sessionId: string, title: string): void;
};

export type SessionActionFailureCode =
  | "CAPABILITY_UNAVAILABLE"
  | "RUNTIME_UNAVAILABLE"
  | "OBSERVER_READ_ONLY"
  | "TRANSFER_PENDING"
  | "STALE_GENERATION"
  | "NO_LEASE"
  | "CONFIRMATION_DECLINED"
  | "HOST_REJECTED"
  | "TRANSPORT_FAILED";

export type SessionActionFailure = {
  code: SessionActionFailureCode;
  hostReasonCode?: string;
};

export type SessionActionOutcome =
  | { ok: true }
  | { ok: false; reason: SessionActionFailure; draft?: string };

export type SessionActionFeature =
  | "create"
  | "rename"
  | "archive"
  | "restore"
  | "delete"
  | "fork";

const FEATURE_BY_ACTION: Readonly<Record<SessionActionFeature, string>> = {
  create: "session.create",
  rename: "session.rename",
  archive: "workspace.archiveSession",
  restore: "session.restoreArchive",
  delete: "session.delete",
  fork: "session.fork",
};

const KIND_BY_ACTION: Readonly<Record<SessionActionFeature, string>> = FEATURE_BY_ACTION;

type CommandShape = {
  kind: string;
  requestId?: string;
  sessionId?: string;
  input?: unknown;
};

export type SessionActionsDeps = {
  facade: { command<T>(lease: ControllerLease, command: CommandShape): Promise<T> };
  lease: () => ControllerLease | undefined;
  context: () => ActionContext;
  catalog: SessionActionCatalog;
  confirm: (action: "delete", session: SessionSummaryLike) => Promise<boolean>;
  nextRequestId: () => string;
};

type HostMutationResult = {
  accepted?: boolean;
  rejection?: { code?: string };
  title?: string;
};

function toFailure(reason: { code: string; hostReasonCode?: string }): SessionActionFailure {
  return reason.hostReasonCode === undefined
    ? { code: reason.code as SessionActionFailureCode }
    : { code: reason.code as SessionActionFailureCode, hostReasonCode: reason.hostReasonCode };
}

/**
 * Guarded Host-backed session lifecycle commands. Availability is always
 * derived from the Host-negotiated context; nothing here synthesizes an
 * action the Host did not advertise.
 */
export function createSessionActions(deps: SessionActionsDeps) {
  function availabilityFor(action: SessionActionFeature) {
    return getActionAvailability(deps.context(), FEATURE_BY_ACTION[action]);
  }

  async function availability(): Promise<Record<SessionActionFeature, ReturnType<typeof availabilityFor>>> {
    return {
      create: availabilityFor("create"),
      rename: availabilityFor("rename"),
      archive: availabilityFor("archive"),
      restore: availabilityFor("restore"),
      delete: availabilityFor("delete"),
      fork: availabilityFor("fork"),
    };
  }

  async function run(
    action: SessionActionFeature,
    session: SessionSummaryLike | undefined,
    input?: unknown,
  ): Promise<{ ok: true; result: HostMutationResult } | { ok: false; reason: SessionActionFailure }> {
    const availability = availabilityFor(action);
    if (!availability.enabled) {
      return { ok: false, reason: toFailure(availability.reason) };
    }
    const lease = deps.lease();
    if (lease === undefined) {
      return { ok: false, reason: { code: "NO_LEASE" } };
    }
    let result: HostMutationResult;
    try {
      result = await deps.facade.command<HostMutationResult>(lease, {
        kind: KIND_BY_ACTION[action],
        requestId: deps.nextRequestId(),
        ...(session ? { sessionId: session.id } : {}),
        ...(input === undefined ? {} : { input }),
      });
    } catch (error) {
      return {
        ok: false,
        reason: {
          code: "TRANSPORT_FAILED",
          hostReasonCode: (error as { code?: string } | undefined)?.code,
        },
      };
    }
    if (result?.accepted === false) {
      return {
        ok: false,
        reason: { code: "HOST_REJECTED", hostReasonCode: result.rejection?.code },
      };
    }
    return { ok: true, result: result ?? {} };
  }

  return {
    availability,
    async create(input?: unknown): Promise<SessionActionOutcome> {
      const outcome = await run("create", undefined, input);
      return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
    },
    async rename(session: SessionSummaryLike, title: string): Promise<SessionActionOutcome> {
      const outcome = await run("rename", session, { title });
      if (!outcome.ok) {
        // The draft belongs to the caller; the projection keeps the Host title.
        return { ok: false, reason: outcome.reason, draft: title };
      }
      deps.catalog.applyRename(session.id, outcome.result.title ?? title);
      return { ok: true };
    },
    async archive(session: SessionSummaryLike): Promise<SessionActionOutcome> {
      const outcome = await run("archive", session);
      return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
    },
    async restore(session: SessionSummaryLike): Promise<SessionActionOutcome> {
      const outcome = await run("restore", session);
      return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
    },
    async fork(session: SessionSummaryLike): Promise<SessionActionOutcome> {
      const outcome = await run("fork", session);
      return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
    },
    async remove(session: SessionSummaryLike): Promise<SessionActionOutcome> {
      const availability = availabilityFor("delete");
      if (!availability.enabled) {
        return { ok: false, reason: toFailure(availability.reason) };
      }
      const confirmed = await deps.confirm("delete", session);
      if (!confirmed) {
        return { ok: false, reason: { code: "CONFIRMATION_DECLINED" } };
      }
      const outcome = await run("delete", session);
      if (!outcome.ok) {
        return { ok: false, reason: outcome.reason };
      }
      // Local cleanup happens only after the confirmed Host success.
      deps.catalog.remove(session.id);
      return { ok: true };
    },
  };
}
