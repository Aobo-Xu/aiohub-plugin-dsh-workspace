/**
 * In-process rc.1 runtime fixture assembled from the official DSH public
 * extension surface (`@deepseek-ai/*` npm packages at the exact locked
 * `0.1.2-rc.1` versions — the same artifact identity pinned by
 * `runtime-lock/dsh-runtime.json` commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`).
 *
 * This is NOT a mock of the adapter under test: every service the adapter
 * consumes (Session Controller, Typert Remote, SessionPersistence, Cordis
 * services, approval, terminal service) is the real published rc.1 code running
 * in-process, per the brief's allowance for "封装真实 service 面的进程内替身"
 * where a full runtime process is too costly. Only the leaves with real
 * process/environment side effects (LLM provider transport, PTY process tree,
 * durable storage medium, prompt attachment admission) are scripted with
 * production-shaped doubles behind their official seams.
 *
 * Service names and method shapes follow the rc.1 sources (`packages/api/session-controller`,
 * `packages/api/workspace-controller`, `packages/interaction/user-approval`,
 * `packages/terminal/terminal`, `packages/api/gateway`) — not guessed names.
 */
import { Context } from "@deepseek-ai/cordis";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader, SessionLogOffset } from "@deepseek-ai/dsh-session";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import type { Agent, AgentFactory } from "@deepseek-ai/dsh-agent";
import SessionPersistence, {
  PersistenceCoordinator,
  SessionPersistenceRevision,
} from "@deepseek-ai/dsh-session-persistence";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SessionQueryEngine from "@deepseek-ai/dsh-session-query";
import TypertRegistry from "@deepseek-ai/dsh-typert-registry";
import SessionController from "@deepseek-ai/dsh-api-session-controller";
import WorkspaceController from "@deepseek-ai/dsh-api-workspace-controller";
import TypertGatewayService from "@deepseek-ai/dsh-api-gateway";
import WorkspaceRegistry from "@deepseek-ai/dsh-workspace";
import Storage from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import type { KvUnitDescriptor, KvUnit, StorageBackend } from "@deepseek-ai/dsh-storage";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import { TerminalSessionService } from "@deepseek-ai/dsh-terminal";
import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalBackendSpawnSpec,
  TerminalSendRequest,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSignal,
  TerminalSignalResult,
  TerminalSessionStatus,
  TerminalWaitReason,
} from "@deepseek-ai/dsh-terminal";
import LlmRuntime, { LlmAdapter } from "@deepseek-ai/dsh-llm";

/** Official public services the rc.1 release must present, by Cordis service key. */
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

/** Schema identity of the official rc.1 session log format (`SESSION_FORMAT_VERSION`). */
export const RC1_SESSION_FORMAT_VERSION = 0;

/** Minimal in-memory persistence backend from the official SessionPersistence contract. */
class FixturePersistence extends SessionPersistence {
  static override readonly inject = ["sessions"];

  override readonly supportsRawArtifacts = false;
  override readonly name = "fixture-session-persistence";

  private readonly store = new Map<
    string,
    { meta: SessionHeader; inheritedEventCount?: number; events: SessionEvent[] }
  >();
  private readonly coordinator: PersistenceCoordinator<never>;

  constructor(ctx: Context) {
    super(ctx);
    this.coordinator = new PersistenceCoordinator<never>(this.ctx, this as never);
  }

  locate(): undefined {
    return undefined;
  }

  create(meta: SessionHeader, inheritedEventCount?: SessionLogOffset): Promise<void> {
    return this.coordinator.create(meta, inheritedEventCount);
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events);
  }

  load(id: SessionId) {
    return this.coordinator.load(id).then((loaded) => ({
      meta: loaded.meta,
      inheritedEventCount: loaded.inheritedEventCount,
      events: [...loaded.events],
    }));
  }

  inspect(id: SessionId, signal?: AbortSignal) {
    return this.coordinator.inspect(id, signal).then((loaded) => ({
      meta: loaded.meta,
      inheritedEventCount: loaded.inheritedEventCount,
      events: [...loaded.events],
    }));
  }

  list() {
    return Promise.resolve([...this.store.values()].map((entry) => structuredClone(entry.meta)));
  }

  async loadStored(id: SessionId) {
    const entry = this.store.get(id);
    if (entry === undefined) return undefined;
    return {
      meta: structuredClone(entry.meta),
      inheritedEventCount: (entry.inheritedEventCount ?? 0) as SessionLogOffset,
      events: structuredClone(entry.events),
      revision: SessionPersistenceRevision(JSON.stringify(entry)),
    };
  }

  async readStoredRevision(id: SessionId) {
    const entry = this.store.get(id);
    return entry === undefined ? undefined : SessionPersistenceRevision(JSON.stringify(entry));
  }

  async appendBatch(
    storage: { meta: SessionHeader; inheritedEventCount: number },
    events: readonly SessionEvent[],
  ): Promise<void> {
    const existing = this.store.get(storage.meta.id);
    if (existing === undefined) {
      this.store.set(storage.meta.id, {
        meta: structuredClone(storage.meta),
        inheritedEventCount: storage.inheritedEventCount,
        events: structuredClone(events) as SessionEvent[],
      });
    } else {
      existing.events.push(...(structuredClone(events) as SessionEvent[]));
    }
  }

  materializeHeader(storage: { meta: SessionHeader; inheritedEventCount: number }): Promise<void> {
    this.store.set(storage.meta.id, {
      meta: structuredClone(storage.meta),
      inheritedEventCount: storage.inheritedEventCount,
      events: [],
    });
    return Promise.resolve();
  }

  async commitRepair(
    storage: { meta: SessionHeader },
    _tornMarker: never,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    const entry = this.store.get(storage.meta.id);
    if (entry === undefined) return;
    if (closers.length > 0) entry.events.push(...(structuredClone(closers) as SessionEvent[]));
  }

  async listSnapshots() {
    return [...this.store.values()].map((entry) => ({
      header: structuredClone(entry.meta),
      revision: SessionPersistenceRevision(JSON.stringify(entry)),
    }));
  }
}

/** Official SessionQueryEngine with search seams stubbed (not exercised by the adapter). */
class FixtureSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error("fixture session query does not implement searchSessions"));
  }

  override async searchEvents(request: { sessionId: SessionId }): Promise<never> {
    return { session: (await this.readSurface(request.sessionId)).session, items: [] } as never;
  }
}

/** Official LlmAdapter that serves the fixture provider route without network transport. */
class FixtureLlmAdapter extends LlmAdapter {
  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider };
  }

  override listModels(): Promise<readonly never[]> {
    return Promise.resolve([]);
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model } as never);
  }

  override async *stream(): AsyncIterable<never> {
    yield {} as never;
  }
}

/** Scripted PTY backend behind the official TerminalBackend seam (no real process tree). */
class FixtureTerminalBackend implements TerminalBackend {
  readonly type = "fixture-pty";
  readonly spawns: TerminalBackendSpawnSpec[] = [];
  private readonly sessions = new Set<TerminalBackendSession>();

  async spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession> {
    this.spawns.push(spec);
    const session: TerminalBackendSession = {
      motd: `fixture motd for ${spec.sessionId}`,
      read(_request: TerminalReadRequest): TerminalReadResult {
        return { text: "hello from fixture pty", totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false };
      },
      startSend(_request: TerminalSendRequest): TerminalSendOperation {
        const done = Promise.resolve({
          viewport: "",
          waitReason: "inferred_idle" as TerminalWaitReason,
          sessionStatus: { kind: "running" } as TerminalSessionStatus,
          truncated: false,
        });
        return {
          done,
          readOutput: () => ({ delta: "", viewport: "", truncated: false }),
          cancel: () => false,
        };
      },
      signal(_signal: TerminalSignal): Promise<TerminalSignalResult> {
        return Promise.resolve({ delivered: true, targetPgid: 1 });
      },
      status(): TerminalSessionStatus {
        return { kind: "running" };
      },
      close: (_reason: string) => {
        this.sessions.delete(session);
        return Promise.resolve();
      },
    };
    this.sessions.add(session);
    return session;
  }
}

/** In-memory KV backend implementing the official StorageBackend/KvUnit contract. */
class FixtureMemoryBackend implements StorageBackend {
  readonly kv;
  private closed = false;

  constructor() {
    this.kv = {
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        if (this.closed) throw new Error("fixture memory backend is closed");
        const tables = new Map<string, Map<string, unknown>>();
        let global: unknown = null;
        return {
          loadAll: async () => {
            const out: Record<string, Record<string, unknown>> = {};
            for (const table of descriptor.tables) out[table] = Object.fromEntries(tables.get(table) ?? []);
            return { tables: out, global };
          },
          putRecord: async (table: string, key: string, value: unknown) => {
            let records = tables.get(table);
            if (records === undefined) {
              records = new Map();
              tables.set(table, records);
            }
            records.set(key, value);
          },
          deleteRecord: async (table: string, key: string) => {
            tables.get(table)?.delete(key);
          },
          setGlobal: async (value: unknown) => {
            global = value;
          },
          close: async () => undefined,
        };
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export type Rc1FixtureOptions = {
  /** Absolute directory sessions/workspaces are created against. */
  cwd: string;
  /** Extra context-level provisioning before controllers mount. */
  provision?: (ctx: Context) => void | Promise<void>;
};

export type Rc1Fixture = {
  ctx: Context;
  services: {
    sessionController: SessionController;
    workspaceController: WorkspaceController;
    typertGateway: TypertGateway;
    approval: ApprovalService;
    terminals: TerminalSessionService;
    sessions: SessionStore;
    agents: AgentRegistry;
  };
  terminalBackend: FixtureTerminalBackend;
  /** Registers the store-backed agent factory used by `sessionController.create`. */
  useAgentFactory(): void;
  dispose(): Promise<void>;
};

type TypertGateway = {
  invoke(request: { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<unknown>;
  stream(request: { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<AsyncIterable<unknown>>;
};

/**
 * Boot the real rc.1 public service surface in one Cordis context. Every
 * service is the official rc.1 implementation; only environment-touching
 * leaves (LLM transport, PTY process tree, storage medium) are scripted.
 */
export async function createRc1Fixture(options: Rc1FixtureOptions): Promise<Rc1Fixture> {
  const ctx = new Context();
  await ctx.plugin(TypertRegistry);
  await ctx.plugin(SessionStore);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(FixturePersistence);
  await ctx.plugin(FixtureSessionQuery);
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(ApprovalService);
  await ctx.plugin(TerminalSessionService);
  await ctx.plugin(Storage);
  ctx.storage.backend.register("memory", new FixtureMemoryBackend());
  const facility = new DomainFacility(ctx, { backend: "memory", routes: {} });
  ctx.storage.mount("domain", facility);
  ctx.provide("storageDomain", facility);
  await ctx.plugin(WorkspaceRegistry);
  await ctx.plugin(TypertGatewayService, { websocketHeartbeatIntervalMs: 1000 });

  ctx.llm.registerAdapter(["fixture"], new FixtureLlmAdapter());
  const terminalBackend = new FixtureTerminalBackend();
  ctx.terminals.registerBackend(terminalBackend);
  ctx.provide("agentDefaultModel", {
    currentSelection: () => ({ provider: "fixture", model: "fixture-model" }),
    saveSelection: () => Promise.resolve(),
  } as never);
  ctx.provide("attachments", {
    imageLimits: {
      maxImageBytes: 4,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 4,
      maxImagePixels: 4,
      maxImageDimension: 2000,
      mediaTypes: ["image/png"],
    },
    validateImage: () => Promise.resolve(),
    saveImage: (input: { data: Uint8Array; mediaType: "image/png" }) =>
      Promise.resolve({
        attachmentId: "fixture-attachment",
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
      }),
  } as never);

  await options.provision?.(ctx);

  const sessionController = new SessionController(ctx, { nativeOpen: false });
  const workspaceController = new WorkspaceController(ctx);

  const fixture: Rc1Fixture = {
    ctx,
    services: {
      sessionController,
      workspaceController,
      typertGateway: ctx.typertGateway as unknown as TypertGateway,
      approval: ctx.approval,
      terminals: ctx.terminals,
      sessions: ctx.sessions,
      agents: ctx.agents,
    },
    terminalBackend,
    useAgentFactory() {
      const factory: AgentFactory = {
        createAgent: async (ownerCtx, agentOptions) => {
          const session = ctx.sessions.create(
            agentOptions.sessionId,
            agentOptions.meta === undefined ? undefined : { meta: agentOptions.meta },
          );
          // The official prompt() path delivers an identified user message
          // through agent.followup/steer; the rc.1 agent-loop would drive the
          // model turn from there. This fixture agent records the delivery
          // durably (the same user/message event the loop writes) without
          // invoking any LLM transport, so history/snapshot/paging read the
          // real session log semantics.
          const deliver = (message: { content: unknown }) => {
            session.append(
              "user/message",
              message as never,
              { surfaceOp: "append" },
            );
          };
          const agent = {
            id: session.id,
            session,
            status: "idle",
            ctx: ownerCtx,
            inbox: { nextTurn: [], nextStep: [] },
            followup: (message: { content: unknown }) => deliver(message),
            steer: (message: { content: unknown }) => deliver(message),
            cancel: () => undefined,
          } as unknown as Agent;
          ctx.agents.register(agent);
          return { agent, dispose: () => Promise.resolve() } as never;
        },
        resume: () => Promise.reject(new Error("fixture agent factory has no resume path")),
      };
      ctx.agents.setFactory(factory);
    },
    async dispose() {
      await ctx.fiber.dispose();
    },
  };
  return fixture;
}

/** Re-exported so tests construct branded ids through the official seam. */
export { SessionId };
export type { Agent, ApprovalOutcome };
