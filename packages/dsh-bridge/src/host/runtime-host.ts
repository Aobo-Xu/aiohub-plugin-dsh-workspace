import type { DshHost } from "./create-host.js";

export type RuntimeHostState =
  | "stopped"
  | "starting"
  | "ready"
  | "maintenance"
  | "upgrading"
  | "recovering"
  | "crashed"
  | "incompatible";

export type CreateRuntimeHostOptions = {
  /** Starts and settles the release adapter through its public Cordis surface. */
  start(): Promise<DshHost>;
  /** Flushes official DSH durable services before normal Cordis disposal. */
  flush?(): Promise<void>;
};

export interface RuntimeHost {
  state(): RuntimeHostState;
  attachSession(sessionId: string): Promise<void>;
  sessions(): readonly string[];
  mutate<T>(handleId: string, operation: () => Promise<T>): Promise<T>;
  trackHandle(handleId: string): void;
  completeHandle(handleId: string): void;
  enterMaintenance(): void;
  leaveMaintenance(): void;
  beginUpgrade(): void;
  beginRecovery(): void;
  markReady(): void;
  markIncompatible(): void;
  crash(): Promise<void>;
  recover(): Promise<void>;
  interruptedHandles(): readonly string[];
  dispose(): Promise<void>;
}

export function createRuntimeHost(options: CreateRuntimeHostOptions): RuntimeHost {
  let state: RuntimeHostState = "stopped";
  let host: DshHost | undefined;
  let startup: Promise<DshHost> | undefined;
  const sessionIds = new Set<string>();
  const activeHandles = new Set<string>();
  const interrupted = new Set<string>();

  async function ensureStarted(
    pendingState: "starting" | "recovering" = "starting",
  ): Promise<DshHost> {
    if (host) return host;
    if (!startup) {
      state = pendingState;
      startup = options.start().then(
        (settledHost) => {
          host = settledHost;
          state = "ready";
          return settledHost;
        },
        (error: unknown) => {
          state = "crashed";
          startup = undefined;
          throw error;
        },
      );
    }
    return startup;
  }

  function requireMutable(): void {
    if (state !== "ready") {
      throw new Error(`HOST_MUTATIONS_FENCED: ${state}`);
    }
  }

  return {
    state: () => state,
    async attachSession(sessionId: string): Promise<void> {
      if (!sessionId) throw new Error("SESSION_ID_REQUIRED");
      await ensureStarted();
      sessionIds.add(sessionId);
    },
    sessions: () => [...sessionIds],
    async mutate<T>(handleId: string, operation: () => Promise<T>): Promise<T> {
      requireMutable();
      if (!handleId) throw new Error("HANDLE_ID_REQUIRED");
      activeHandles.add(handleId);
      return operation();
    },
    trackHandle(handleId: string): void {
      requireMutable();
      if (!handleId) throw new Error("HANDLE_ID_REQUIRED");
      activeHandles.add(handleId);
    },
    completeHandle(handleId: string): void {
      activeHandles.delete(handleId);
    },
    enterMaintenance(): void {
      if (state === "ready") state = "maintenance";
    },
    leaveMaintenance(): void {
      if (state === "maintenance") state = "ready";
    },
    beginUpgrade(): void {
      if (state === "ready" || state === "maintenance") state = "upgrading";
    },
    beginRecovery(): void {
      if (state === "crashed" || state === "maintenance" || state === "upgrading") {
        state = "recovering";
      }
    },
    markReady(): void {
      if (state === "recovering" || state === "starting") state = "ready";
    },
    markIncompatible(): void {
      state = "incompatible";
    },
    async crash(): Promise<void> {
      if (state === "stopped" || state === "incompatible") return;
      for (const handleId of activeHandles) interrupted.add(handleId);
      activeHandles.clear();
      state = "crashed";
      const current = host;
      host = undefined;
      startup = undefined;
      await current?.dispose();
    },
    async recover(): Promise<void> {
      if (state !== "crashed") {
        throw new Error(`HOST_RECOVERY_NOT_ALLOWED: ${state}`);
      }
      await ensureStarted("recovering");
    },
    interruptedHandles: () => [...interrupted].sort(),
    async dispose(): Promise<void> {
      const current = host;
      host = undefined;
      startup = undefined;
      activeHandles.clear();
      sessionIds.clear();
      state = "stopped";
      if (current) {
        try {
          await options.flush?.();
        } finally {
          await current.dispose();
        }
      }
    },
  };
}
