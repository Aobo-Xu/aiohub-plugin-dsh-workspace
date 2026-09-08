/**
 * `v0.1.2-rc.1` release adapter (Task 5): binds the Host seam to the official
 * DSH public extension surface — Session Controller, Typert Remote, Session
 * Persistence, Cordis services, the approval service, and the terminal service.
 *
 * Release-specific imports and event mapping are confined to this file. Every
 * capability is proved from the runtime's public service settlement; operations
 * the release does not expose return capability unavailable and are never
 * simulated in the bridge. The adapter never derives a decision from the
 * release version — the releaseTag/commit are provenance only.
 */
import type {
  AdapterIdentity,
  AdapterPort,
  AdapterProbe,
  DshReleaseAdapter,
  MigrationInput,
  MigrationResult,
  NegotiatedCapabilities,
} from "./types.js";
import type {
  CapabilityDescriptor,
  OperationAvailability,
} from "../../../runtime-facade/src/types.js";
import {
  availabilityFor,
  capability,
  settledServiceNames,
} from "./shared/public-services.js";

/** Cordis service keys the official rc.1 control plane exposes. */
export const RC1_SERVICE_EVIDENCE = [
  "typertGateway",
  "typert",
  "sessions",
  "agents",
  "sessionPersistence",
  "sessionProjections",
  "sessionQuery",
  "sessionController",
  "workspaceRegistry",
  "workspaceController",
  "approval",
  "terminals",
  "llm",
] as const;

/** Schema identity of the official rc.1 session log format. */
export const RC1_SCHEMA_VERSION = 0;

export const RC1_ADAPTER_ID = "aiohub-dsh-rc1";

/** Release provenance recorded from the runtime lock (never a selection input). */
export const RC1_IDENTITY: AdapterIdentity = {
  adapterId: RC1_ADAPTER_ID,
  releaseTag: "dsh-v0.1.2-rc.1",
  releaseCommit: "a66e4702047846cdaa10c66c9d3df3951f5ea70d",
  schemaVersion: RC1_SCHEMA_VERSION,
  serviceEvidence: [...RC1_SERVICE_EVIDENCE],
};

/** A settled-operation guard failure: the operation was not proved available. */
export class CapabilityUnavailableError extends Error {
  public readonly operationId: string;

  constructor(operationId: string) {
    super(`CAPABILITY_UNAVAILABLE: ${operationId}`);
    this.name = "CapabilityUnavailableError";
    this.operationId = operationId;
  }
}

/**
 * The runtime face the adapter consumes. The official rc.1 services are
 * reachable through a live Cordis context; this seam names only the public
 * surface, so both the in-process fixture and a real runtime host satisfy it
 * with the same shapes.
 */
export type Rc1RuntimeSurface = {
  ctx: {
    get?(service: string): unknown;
    /** Cordis context event registration (the `approval/request` waterfall listens here). */
    on(event: "approval/request", listener: () => Promise<"allowed-once" | "rejected">): () => void;
    sessionController: {
      create(request: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }>;
      inspect(sessionId: string, signal?: AbortSignal): Promise<{
        meta: { version: number; id: string; createdAt: number; cwd?: string };
        inheritedEventCount: number;
        events: ReadonlyArray<{ type: string; seq: number; time: number; data: unknown }>;
      }>;
      page(request: { address: { kind: "session"; sessionId: string }; throughSeq: number; beforeSeq?: number; maxMessages?: number }, signal: AbortSignal): Promise<{
        records: ReadonlyArray<{ type: "event"; event: { type: string; seq: number; time: number; data: unknown } } | { type: "chunks"; event: unknown }>;
        hasMore: boolean;
      }>;
      follow(request: { address: { kind: "session"; sessionId: string }; maxMessages?: number }, signal: AbortSignal): AsyncIterable<
        | { type: "snapshot"; header: { version: number; id: string; createdAt: number }; cursor: number; records: unknown[]; hasMore: boolean; projections: { asOfSeq: number; values: Record<string, unknown> } }
        | { type: "event"; event: { type: string; seq: number; time: number; data: unknown } }
      >;
      prompt(request: { requestId: string; sessionId: string; mode: "queue" | "steer"; content: ReadonlyArray<{ type: "text"; text: string } | { type: "image"; mediaType: string; data: string; name?: string }> }, signal: AbortSignal): Promise<{ accepted: true }>;
      cancel(request: { sessionId: string }): { accepted: true };
      list(request: Record<string, never>, signal: AbortSignal): Promise<{ items: ReadonlyArray<{ sessionId: string; updatedAt: number; running: boolean; blank: boolean }> }>;
      search?(request: { query: string }, signal: AbortSignal): Promise<{ items: ReadonlyArray<unknown>; hasMore: boolean }>;
      resolveAgent?(sessionId: string): Promise<unknown>;
      rename?(request: { sessionId: string; title: string }): Promise<{ title: string; seq: number }>;
      fork?(request: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }>;
      updateQueue?(request: { sessionId: string; itemId: string; action: unknown }): { accepted: true };
      selectModel?(request: { sessionId: string; provider: string; model: string }): Promise<unknown>;
    };
    workspaceController: {
      follow(signal: AbortSignal): AsyncIterable<unknown>;
      create?(request: { path: string }): Promise<{ workspace: { workspaceId: string; path: string; title: string }; created: boolean }>;
      rename?(request: { workspaceId: string; title: string }): Promise<{ workspace: { workspaceId: string; path: string; title: string } }>;
      delete?(request: { workspaceId: string }): Promise<{ deleted: true }>;
      archiveSession?(request: { sessionId: string }): Promise<{ archivedSessionIds: readonly string[] }>;
    };
    typertGateway: {
      invoke(request: { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<unknown>;
    };
    approval: {
      request(request: { agent: unknown; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }): Promise<"allowed-once" | "rejected" | "cancelled" | "unavailable">;
    };
    terminals: {
      spawn(owner: unknown, request: { type: string; name?: string; cwd?: string }, signal?: AbortSignal): Promise<{ sessionId: string; motd: string; status: { kind: string } }>;
      read(owner: unknown, id: string, request?: { offset?: number; count?: number }): { text: string; totalLines: number; truncated: boolean };
      startSend(owner: unknown, id: string, request: { text: string; submit: boolean }): { done: Promise<{ waitReason: string; sessionStatus: { kind: string } }>; cancel(): boolean };
      kill(owner: unknown, id: string, reason?: string): Promise<boolean>;
      list(owner: unknown): ReadonlyArray<{ sessionId: string; type: string; status: { kind: string } }>;
    };
    sessions: {
      get(sessionId: string): { id: string } | undefined;
    };
    agents: {
      get(agentId: string): unknown;
    };
  };
};

type Rc1AdapterOptions = {
  runtime: Rc1RuntimeSurface;
};

/** Capability vocabulary proved from the rc.1 public service settlement. */
function rc1Capabilities(runtime: Rc1RuntimeSurface, schemaRevision: number): CapabilityDescriptor[] {
  const capabilities = [
    capability("workspace.follow", schemaRevision, "observe"),
    capability("session.open", schemaRevision, "read"),
    capability("session.snapshot", schemaRevision, "read"),
    capability("session.history", schemaRevision, "read"),
    capability("session.subscribe", schemaRevision, "observe"),
    capability("session.submit-prompt", schemaRevision, "mutate"),
    capability("session.cancel", schemaRevision, "mutate"),
    capability("session.list", schemaRevision, "read"),
    capability("interaction.approval", schemaRevision, "mutate"),
    capability("terminal.open", schemaRevision, "mutate"),
    capability("terminal.read", schemaRevision, "read"),
    capability("terminal.send", schemaRevision, "mutate"),
    capability("terminal.close", schemaRevision, "mutate"),
  ];
  const optional: Array<[boolean, string, CapabilityDescriptor["mode"]]> = [
    [typeof runtime.ctx.workspaceController.create === "function", "workspace.create", "mutate"],
    [typeof runtime.ctx.workspaceController.rename === "function", "workspace.rename", "mutate"],
    [typeof runtime.ctx.workspaceController.delete === "function", "workspace.delete", "mutate"],
    [typeof runtime.ctx.workspaceController.archiveSession === "function", "workspace.archive-session", "mutate"],
    [typeof runtime.ctx.sessionController.create === "function", "session.create", "mutate"],
    [typeof runtime.ctx.sessionController.search === "function", "session.search", "read"],
    [typeof runtime.ctx.sessionController.resolveAgent === "function", "session.resume", "mutate"],
    [typeof runtime.ctx.sessionController.rename === "function" && runtime.ctx.get?.("sessionTitle") !== undefined, "session.rename", "mutate"],
    [typeof runtime.ctx.sessionController.fork === "function", "session.fork", "mutate"],
    [typeof runtime.ctx.sessionController.updateQueue === "function", "session.update-queue", "mutate"],
    [typeof runtime.ctx.sessionController.selectModel === "function", "session.select-model", "mutate"],
  ];
  for (const [available, id, mode] of optional) {
    if (available) capabilities.push(capability(id, schemaRevision, mode));
  }
  return capabilities;
}

function requireAvailable(capabilities: readonly CapabilityDescriptor[], operationId: string): void {
  if (!availabilityFor(capabilities, operationId).available) {
    throw new CapabilityUnavailableError(operationId);
  }
}

/** Wire history/snapshot records into the seam DTO (release-specific mapping). */
function mapHistoryRecord(record: { type: string; event?: { type: string; seq: number; time: number; data: unknown } }): {
  type: string;
  event?: { type: string; seq: number; time: number; data: unknown };
} {
  if (record.type === "chunks") {
    // Packed assistant-delta runs are a wire-side compaction of the rc.1
    // Remote journal; the Host seam receives them as opaque packed records.
    return { type: record.type };
  }
  return {
    type: record.type,
    ...(record.event === undefined ? {} : {
      event: {
        type: record.event.type,
        seq: record.event.seq,
        time: record.event.time,
        data: record.event.data,
      },
    }),
  };
}

/**
 * Builds the rc.1 release adapter over a live runtime surface. The port objects
 * carry both the seam-level `operationAvailability` and the concrete operations
 * the Host composition root hands out through `host.port(...)`.
 */
export function createRc1Adapter(options: Rc1AdapterOptions): DshReleaseAdapter {
  const { runtime } = options;
  const identity: AdapterIdentity = { ...RC1_IDENTITY, serviceEvidence: [...RC1_SERVICE_EVIDENCE] };

  let settledCapabilities: readonly CapabilityDescriptor[] = [];
  let disposed = false;

  function requireSettled(): readonly CapabilityDescriptor[] {
    if (settledCapabilities.length === 0) {
      throw new Error("rc1 adapter operations require settle() to prove capabilities first");
    }
    return settledCapabilities;
  }

  function basePort(operationId: string): AdapterPort & { __operationId: string } {
    return {
      __operationId: operationId,
      operationAvailability(otherOperationId: string): OperationAvailability {
        if (disposed) {
          return { available: false, reason: { code: "TEMPORARILY_UNAVAILABLE" } };
        }
        return availabilityFor(settledCapabilities, otherOperationId);
      },
    };
  }

  function sessionOwner(sessionId: string): { agent?: unknown } | undefined {
    return runtime.ctx.sessions.get(sessionId) as { agent?: unknown } | undefined;
  }

  const workspaces = {
    ...basePort("workspace.create"),
    async create(input: { path: string }): Promise<{ workspaceId: string; path: string; title: string; created: boolean }> {
      requireAvailable(requireSettled(), "workspace.create");
      const value = await runtime.ctx.workspaceController.create!({ path: input.path });
      return { ...value.workspace, created: value.created };
    },
    async follow(): Promise<AsyncIterable<unknown>> {
      requireAvailable(requireSettled(), "workspace.follow");
      return runtime.ctx.workspaceController.follow(new AbortController().signal);
    },
    async rename(input: { workspaceId: string; title: string }): Promise<{ workspaceId: string; path: string; title: string }> {
      requireAvailable(requireSettled(), "workspace.rename");
      const value = await runtime.ctx.workspaceController.rename!(input);
      return value.workspace;
    },
    async delete(input: { workspaceId: string }): Promise<{ deleted: true }> {
      requireAvailable(requireSettled(), "workspace.delete");
      return runtime.ctx.workspaceController.delete!(input);
    },
    async archiveSession(input: { sessionId: string }): Promise<{ archivedSessionIds: readonly string[] }> {
      requireAvailable(requireSettled(), "workspace.archive-session");
      return runtime.ctx.workspaceController.archiveSession!(input);
    },
  };

  const sessions = {
    ...basePort("session.create"),
    async create(input: { cwd?: string; workspaceId?: string; sessionId?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }> {
      requireAvailable(requireSettled(), "session.create");
      return runtime.ctx.sessionController.create({
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
      });
    },
    async open(input: { sessionId: string }): Promise<{
      header: { version: number; id: string; createdAt: number; cwd?: string };
      events: ReadonlyArray<{ type: string; seq: number; time: number; data: unknown }>;
    }> {
      requireAvailable(requireSettled(), "session.open");
      const inspection = await runtime.ctx.sessionController.inspect(input.sessionId);
      return { header: inspection.meta, events: inspection.events };
    },
    async snapshot(input: { sessionId: string }): Promise<{
      type: "snapshot";
      header: { version: number; id: string; createdAt: number };
      cursor: number;
      records: ReadonlyArray<ReturnType<typeof mapHistoryRecord>>;
      hasMore: boolean;
      projections: { asOfSeq: number; values: Record<string, unknown> };
    }> {
      requireAvailable(requireSettled(), "session.snapshot");
      const signal = new AbortController();
      const iterator = runtime.ctx.sessionController.follow(
        { address: { kind: "session", sessionId: input.sessionId } },
        signal.signal,
      )[Symbol.asyncIterator]();
      const first = await iterator.next();
      signal.abort();
      void iterator.next().catch(() => undefined);
      if (first.done || first.value.type !== "snapshot") {
        throw new Error("rc1 session snapshot: follow did not open with a snapshot frame");
      }
      return {
        type: "snapshot",
        header: first.value.header,
        cursor: first.value.cursor,
        records: first.value.records.map((record) => mapHistoryRecord(record as { type: string })),
        hasMore: first.value.hasMore,
        projections: first.value.projections,
      };
    },
    async history(input: { sessionId: string; throughSeq: number; beforeSeq?: number; maxMessages?: number }, signal = new AbortController().signal): Promise<{
      records: ReadonlyArray<ReturnType<typeof mapHistoryRecord>>;
      hasMore: boolean;
    }> {
      requireAvailable(requireSettled(), "session.history");
      const page = await runtime.ctx.sessionController.page(
        {
          address: { kind: "session", sessionId: input.sessionId },
          throughSeq: input.throughSeq,
          ...(input.beforeSeq === undefined ? {} : { beforeSeq: input.beforeSeq }),
          ...(input.maxMessages === undefined ? {} : { maxMessages: input.maxMessages }),
        },
        signal,
      );
      return { records: page.records.map((record) => mapHistoryRecord(record as { type: string })), hasMore: page.hasMore };
    },
    async subscribe(input: { sessionId: string }): Promise<AsyncIterable<{ type: string; event?: { type: string; seq: number; time: number; data: unknown } }>> {
      requireAvailable(requireSettled(), "session.subscribe");
      return runtime.ctx.sessionController.follow(
        { address: { kind: "session", sessionId: input.sessionId } },
        new AbortController().signal,
      );
    },
    async submitPrompt(input: {
      sessionId: string;
      requestId: string;
      content: ReadonlyArray<{ type: "text"; text: string } | { type: "image"; mediaType: string; data: string; name?: string }>;
      mode?: "queue" | "steer";
    }): Promise<{ accepted: boolean }> {
      requireAvailable(requireSettled(), "session.submit-prompt");
      const value = await runtime.ctx.sessionController.prompt(
        {
          requestId: input.requestId,
          sessionId: input.sessionId,
          mode: input.mode ?? "queue",
          content: input.content,
        },
        new AbortController().signal,
      );
      return { accepted: value.accepted };
    },
    async cancel(input: { sessionId: string }): Promise<{ accepted: boolean }> {
      requireAvailable(requireSettled(), "session.cancel");
      return runtime.ctx.sessionController.cancel({ sessionId: input.sessionId });
    },
    async list(): Promise<ReadonlyArray<{ sessionId: string; updatedAt: number; running: boolean; blank: boolean }>> {
      requireAvailable(requireSettled(), "session.list");
      const value = await runtime.ctx.sessionController.list({}, new AbortController().signal);
      return value.items;
    },
    async search(input: { query: string }, signal = new AbortController().signal): Promise<{ items: ReadonlyArray<unknown>; hasMore: boolean }> {
      requireAvailable(requireSettled(), "session.search");
      return runtime.ctx.sessionController.search!(input, signal);
    },
    async resume(input: { sessionId: string }): Promise<unknown> {
      requireAvailable(requireSettled(), "session.resume");
      return runtime.ctx.sessionController.resolveAgent!(input.sessionId);
    },
    async rename(input: { sessionId: string; title: string }): Promise<{ title: string; seq: number }> {
      requireAvailable(requireSettled(), "session.rename");
      return runtime.ctx.sessionController.rename!(input);
    },
    async fork(input: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }> {
      requireAvailable(requireSettled(), "session.fork");
      return runtime.ctx.sessionController.fork!(input);
    },
    async updateQueue(input: { sessionId: string; itemId: string; action: unknown }): Promise<{ accepted: true }> {
      requireAvailable(requireSettled(), "session.update-queue");
      return runtime.ctx.sessionController.updateQueue!(input);
    },
    async selectModel(input: { sessionId: string; provider: string; model: string }): Promise<unknown> {
      requireAvailable(requireSettled(), "session.select-model");
      return runtime.ctx.sessionController.selectModel!(input);
    },
  };

  const interactions = {
    ...basePort("interaction.approval"),
    /**
     * Resolves one approval decision through the official ApprovalService. The
     * answerer is registered as a Cordis waterfall listener for the exact
     * session agent (scope filtering is the service's own contract); the
     * returned correlation id pairs with the approval/asked + approval/decided
     * audit pair the service appends to the session log.
     */
    async resolveApproval(input: {
      sessionId: string;
      toolName: string;
      decision: "allow-once" | "deny";
    }): Promise<{ outcome: string; correlationId: string }> {
      requireAvailable(requireSettled(), "interaction.approval");
      const owner = sessionOwner(input.sessionId);
      if (owner === undefined) {
        throw new Error(`rc1 interaction: session "${input.sessionId}" is not attached`);
      }
      const outcome = input.decision === "allow-once" ? "allowed-once" as const : "rejected" as const;
      // The official ApprovalService consults answerers through the Cordis
      // `approval/request` waterfall scoped to the agent; register the host's
      // decision for exactly this request, then unregister.
      const unregister = runtime.ctx.on("approval/request", () => Promise.resolve(outcome));
      try {
        const agent = runtime.ctx.agents.get(input.sessionId) ?? owner;
        const resolved = await runtime.ctx.approval.request({ agent, toolName: input.toolName });
        return { outcome: resolved, correlationId: `${input.sessionId}:${input.toolName}` };
      } finally {
        unregister();
      }
    },
  };

  const terminals = {
    ...basePort("terminal.open"),
    async open(input: { sessionId: string; type?: string; name?: string }): Promise<{ handleId: string; motd: string; status: { kind: string } }> {
      requireAvailable(requireSettled(), "terminal.open");
      const owner = sessionOwner(input.sessionId);
      if (owner === undefined) {
        throw new Error(`rc1 terminal: session "${input.sessionId}" is not attached`);
      }
      const agent = runtime.ctx.agents.get(input.sessionId) ?? owner;
      const value = await runtime.ctx.terminals.spawn(
        agent,
        { type: input.type ?? "fixture-pty", ...(input.name === undefined ? {} : { name: input.name }) },
      );
      return { handleId: value.sessionId, motd: value.motd, status: value.status };
    },
    async read(input: { sessionId: string; handleId: string }): Promise<{ text: string; totalLines: number; truncated: boolean }> {
      requireAvailable(requireSettled(), "terminal.read");
      const agent = runtime.ctx.agents.get(input.sessionId) ?? sessionOwner(input.sessionId);
      const value = runtime.ctx.terminals.read(agent, input.handleId);
      return { text: value.text, totalLines: value.totalLines, truncated: value.truncated };
    },
    async send(input: { sessionId: string; handleId: string; text: string; submit: boolean }): Promise<{ waitReason: string; sessionStatus: { kind: string } }> {
      requireAvailable(requireSettled(), "terminal.send");
      const agent = runtime.ctx.agents.get(input.sessionId) ?? sessionOwner(input.sessionId);
      const operation = runtime.ctx.terminals.startSend(agent, input.handleId, { text: input.text, submit: input.submit });
      return await operation.done;
    },
    async close(input: { sessionId: string; handleId: string }): Promise<{ closed: boolean }> {
      requireAvailable(requireSettled(), "terminal.close");
      const agent = runtime.ctx.agents.get(input.sessionId) ?? sessionOwner(input.sessionId);
      return { closed: await runtime.ctx.terminals.kill(agent, input.handleId, "host close") };
    },
    list(input: { sessionId: string }): ReadonlyArray<{ handleId: string; type: string; status: { kind: string } }> {
      requireAvailable(requireSettled(), "terminal.open");
      const agent = runtime.ctx.agents.get(input.sessionId) ?? sessionOwner(input.sessionId);
      return runtime.ctx.terminals.list(agent).map((snapshot) => ({
        handleId: snapshot.sessionId,
        type: snapshot.type,
        status: snapshot.status,
      }));
    },
  };

  // rc.1 exposes no dedicated projection/artifact/preset/dynamic-runtime
  // service on its public surface: those ports fail closed (no settled
  // capability ever claims their operations) and the bridge does not improvise.
  const projections: AdapterPort = {
    ...basePort("projections"),
  };
  const artifacts: AdapterPort = {
    ...basePort("artifacts"),
  };
  const presets: AdapterPort = {
    ...basePort("presets"),
  };
  const dynamicRuntime: AdapterPort = {
    ...basePort("dynamicRuntime"),
  };

  return {
    identity,
    async probe(): Promise<AdapterProbe> {
      if (disposed) {
        return { ok: false, schemaVersion: RC1_SCHEMA_VERSION, services: [], capabilities: [] };
      }
      const services = settledServiceNames(runtime.ctx, RC1_SERVICE_EVIDENCE);
      const ok = (RC1_SERVICE_EVIDENCE as readonly string[]).every((service) => services.includes(service));
      return {
        ok,
        schemaVersion: RC1_SCHEMA_VERSION,
        services,
        capabilities: ok ? rc1Capabilities(runtime, RC1_SCHEMA_VERSION) : [],
      };
    },
    async settle(): Promise<NegotiatedCapabilities> {
      const probe = await this.probe();
      if (!probe.ok) {
        throw new Error(
          `rc1 adapter settle failed: missing services ${RC1_SERVICE_EVIDENCE
            .filter((service) => !probe.services.includes(service))
            .join(", ")}`,
        );
      }
      settledCapabilities = probe.capabilities;
      return { schemaVersion: probe.schemaVersion, capabilities: [...probe.capabilities] };
    },
    workspaces,
    sessions,
    projections,
    interactions,
    artifacts,
    terminals,
    presets,
    dynamicRuntime,
    async migrate(_input: MigrationInput): Promise<MigrationResult> {
      // The rc.1 public surface has no cross-release session migration path:
      // report not-migrated with the fail-closed reason instead of improvising.
      return { status: "not-migrated", reason: { code: "CAPABILITY_NOT_NEGOTIATED" } };
    },
    async dispose(): Promise<void> {
      disposed = true;
      settledCapabilities = [];
    },
  };
}

/**
 * Registry hook: registers the rc.1 factory with its exact public-evidence
 * requirement (schemaVersion equality + the full service evidence set).
 */
export function registerRc1Adapter(
  registry: {
    register(factory: () => DshReleaseAdapter, requirement?: { requiredServices?: readonly string[]; schemaVersion?: number }): unknown;
  },
  options: Rc1AdapterOptions,
): unknown {
  return registry.register(() => createRc1Adapter(options), {
    requiredServices: [...RC1_SERVICE_EVIDENCE],
    schemaVersion: RC1_SCHEMA_VERSION,
  });
}
