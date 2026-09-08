/**
 * Public-API compatibility fixture derived from the immutable upstream tag
 * dsh-v0.1.3-alpha.2 (commit 82a5fd61a7cf5c293cec4bdff68f455398d685e9).
 *
 * This is deliberately not an executable-runtime fixture: that release has no
 * official Windows runtime wheel. It captures only public controller/event
 * shapes needed to prove the adapter mapping without importing private DSH
 * modules or treating source compatibility as an executable smoke result.
 */
import type { Rc1RuntimeSurface } from "../../src/adapters/rc1.js";

export const ALPHA2_SOURCE_TAG = "dsh-v0.1.3-alpha.2";
export const ALPHA2_SOURCE_COMMIT = "82a5fd61a7cf5c293cec4bdff68f455398d685e9";
export const ALPHA2_SESSION_FORMAT_VERSION = 2;

export type Alpha2CompatibilitySnapshot = {
  header: {
    version: 2;
    id: string;
    createdAt: number;
    isSeeded: boolean;
    delegationDepth: number;
  };
  turnConfig: {
    persona: {
      prefixSource: string;
      suffixSource: string;
    };
  };
  queue: ReadonlyArray<{
    id: string;
    state: "queued" | "sending";
  }>;
  subagents: ReadonlyArray<{
    id: string;
    mode: "one-shot" | "continuable";
    activity: "running" | "inactive";
  }>;
  processHandles: ReadonlyArray<{
    handleId: string;
    state: "running" | "exited";
  }>;
  ptcCalls: ReadonlyArray<{
    callId: string;
    command: string;
    output: unknown;
  }>;
};

export function alpha2CompatibilitySnapshot(): Alpha2CompatibilitySnapshot {
  return {
    header: {
      version: 2,
      id: "alpha2-session",
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
    },
    turnConfig: {
      persona: {
        prefixSource: "model-persona",
        suffixSource: "environment-context",
      },
    },
    queue: [{ id: "queued-message", state: "sending" }],
    subagents: [{ id: "child-session", mode: "continuable", activity: "running" }],
    // A broader/older producer may still carry diagnostic pid data. The
    // alpha.2 stable projection must not rely on or expose it.
    processHandles: [{ handleId: "process-handle", state: "running", pid: 4242 }],
    ptcCalls: [{ callId: "ptc-call", command: "git status --short", output: " M file.ts" }],
  };
}

export type Alpha2SourceFixture = Rc1RuntimeSurface & {
  compatibilitySnapshot(): Alpha2CompatibilitySnapshot;
};

/** Minimal settled public surface used by source/API compatibility tests. */
export function createAlpha2SourceFixture(): Alpha2SourceFixture {
  const snapshot = alpha2CompatibilitySnapshot();
  const sessions = new Map<string, { id: string }>();
  const follow = async function* () {
    yield {
      type: "snapshot" as const,
      header: snapshot.header,
      cursor: 0,
      records: [],
      hasMore: false,
      projections: { asOfSeq: -1, values: { compatibility: snapshot } },
    };
  };
  const runtime = {
    ctx: {
      on: () => () => undefined,
      sessionController: {
        async create(request: { sessionId?: string }) {
          const sessionId = request.sessionId ?? snapshot.header.id;
          sessions.set(sessionId, { id: sessionId });
          return { sessionId };
        },
        async inspect(sessionId: string) {
          return {
            meta: { ...snapshot.header, id: sessionId },
            inheritedEventCount: 0,
            events: [],
          };
        },
        async page() {
          return { records: [], hasMore: false };
        },
        follow,
        async prompt() {
          return { accepted: true as const };
        },
        cancel() {
          return { accepted: true as const };
        },
        async list() {
          return { items: [] };
        },
      },
      workspaceController: { follow },
      typertGateway: {
        async invoke() {
          return {
            workspace: { workspaceId: "alpha2-workspace", path: "C:\\workspace", title: "workspace" },
            created: true,
          };
        },
      },
      approval: {
        async request() {
          return "allowed-once" as const;
        },
      },
      terminals: {
        async spawn() {
          return { sessionId: "terminal-handle", motd: "alpha2", status: { kind: "running" } };
        },
        read() {
          return { text: "", totalLines: 0, truncated: false };
        },
        startSend() {
          return {
            done: Promise.resolve({ waitReason: "inferred_idle", sessionStatus: { kind: "running" } }),
            cancel: () => false,
          };
        },
        async kill() {
          return true;
        },
        list() {
          return [];
        },
      },
      sessions: { get: (sessionId: string) => sessions.get(sessionId) },
      agents: { get: (sessionId: string) => sessions.get(sessionId) },
      sessionPersistence: {},
      sessionProjections: {},
      sessionQuery: {},
      workspaceRegistry: {},
      llm: {},
      typert: {},
    },
    compatibilitySnapshot: () => alpha2CompatibilitySnapshot(),
  };
  return runtime as unknown as Alpha2SourceFixture;
}
