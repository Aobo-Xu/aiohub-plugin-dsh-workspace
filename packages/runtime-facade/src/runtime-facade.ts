import type {
  AcquireSessionInput,
  ControllerLease,
  InitializeInput,
  InitializeResult,
  RuntimeCommand,
  RuntimeEvent,
  RuntimeFacade,
  RuntimeRef,
  RuntimeState,
  SandboxStatus,
  SessionSnapshot,
  SidecarTransport,
  TransferControllerInput,
} from "./types.js";

const RUNTIME_STATES = new Set<RuntimeState>([
  "stopped",
  "starting",
  "ready",
  "busy",
  "stopping",
  "crashed",
  "unavailable",
]);
const SANDBOX_LEVELS = new Set<SandboxStatus["level"]>(["full", "partial"]);
const SANDBOX_BACKENDS = new Set<SandboxStatus["backend"]>([
  "bwrap",
  "landlock",
  "seatbelt",
  "restricted-token",
]);
const LEASE_MODES = new Set<ControllerLease["mode"]>([
  "controller",
  "observer",
]);

export class SidecarRuntimeFacade implements RuntimeFacade {
  public constructor(private readonly transport: SidecarTransport) {}

  public async initialize(input: InitializeInput): Promise<InitializeResult> {
    return validateInitializeResult(await this.transport.request("initialize", input));
  }

  public async acquireSession(
    input: AcquireSessionInput
  ): Promise<ControllerLease> {
    return validateControllerLease(
      await this.transport.request("acquireSession", input)
    );
  }

  public async transferController(
    input: TransferControllerInput
  ): Promise<ControllerLease> {
    return validateControllerLease(
      await this.transport.request("transferController", input)
    );
  }

  public command<T>(
    lease: ControllerLease,
    command: RuntimeCommand
  ): Promise<T> {
    return this.transport.request("command", { lease, command });
  }

  public async snapshot(
    sessionId: string,
    cursor?: string
  ): Promise<SessionSnapshot> {
    return validateSessionSnapshot(
      await this.transport.request("snapshot", { sessionId, cursor })
    );
  }

  public subscribe(listener: (event: RuntimeEvent) => void): () => void {
    return this.transport.onEvent((value) => listener(validateRuntimeEvent(value)));
  }

  public async shutdown(
    reason: "plugin-disabled" | "aio-exit" | "user-stop"
  ): Promise<void> {
    let gracefulFailed = false;
    let gracefulError: unknown;

    try {
      await this.transport.request("shutdown", { reason });
    } catch (error) {
      gracefulFailed = true;
      gracefulError = error;
    }

    try {
      await this.transport.kill();
    } catch (killError) {
      if (gracefulFailed) {
        throw new AggregateError(
          [gracefulError, killError],
          "DSH graceful shutdown and Sidecar disable both failed."
        );
      }
      throw killError;
    }

    if (gracefulFailed) {
      throw gracefulError;
    }
  }
}

function validateInitializeResult(value: unknown): InitializeResult {
  if (!isRecord(value) || !hasRuntimeRef(value)) invalid("initialize result");
  if (!isRuntimeState(value.state) || !isStringArray(value.capabilities)) {
    invalid("initialize result");
  }

  return {
    ...toRuntimeRef(value),
    state: value.state,
    capabilities: value.capabilities,
    sandbox: validateSandboxStatus(value.sandbox, "initialize result"),
  };
}

function validateControllerLease(value: unknown): ControllerLease {
  if (
    !isRecord(value) ||
    !hasRuntimeRef(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.leaseId !== "string" ||
    !isLeaseMode(value.mode)
  ) {
    invalid("controller lease");
  }

  return {
    ...toRuntimeRef(value),
    sessionId: value.sessionId,
    leaseId: value.leaseId,
    mode: value.mode,
  };
}

function validateSessionSnapshot(value: unknown): SessionSnapshot {
  const seq = isRecord(value) ? value.seq : undefined;

  if (
    !isRecord(value) ||
    !hasRuntimeRef(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.cursor !== "string" ||
    !isNonNegativeSafeInteger(seq) ||
    !Array.isArray(value.durableFacts)
  ) {
    invalid("session snapshot");
  }

  return {
    ...toRuntimeRef(value),
    sessionId: value.sessionId,
    cursor: value.cursor,
    seq,
    durableFacts: value.durableFacts.map(validateRuntimeEvent),
  };
}

function validateRuntimeEvent(value: unknown): RuntimeEvent {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !("data" in value) ||
    ("sessionId" in value && typeof value.sessionId !== "string") ||
    ("turnId" in value && typeof value.turnId !== "string")
  ) {
    invalid("runtime event");
  }

  const sessionId = value.sessionId;
  const turnId = value.turnId;

  return {
    kind: value.kind,
    ...(typeof sessionId === "string" ? { sessionId } : {}),
    ...(typeof turnId === "string" ? { turnId } : {}),
    data: value.data,
  };
}

function validateSandboxStatus(
  value: unknown,
  parent: string
): SandboxStatus {
  if (
    !isRecord(value) ||
    !isSandboxLevel(value.level) ||
    !isSandboxBackend(value.backend) ||
    ("reason" in value && typeof value.reason !== "string")
  ) {
    invalid(parent);
  }

  const reason = value.reason;

  return {
    level: value.level,
    backend: value.backend,
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasRuntimeRef(value: Record<string, unknown>): boolean {
  return (
    typeof value.domainGenerationId === "string" &&
    typeof value.contractHash === "string"
  );
}

function toRuntimeRef(value: Record<string, unknown>): RuntimeRef {
  if (
    typeof value.domainGenerationId !== "string" ||
    typeof value.contractHash !== "string"
  ) {
    invalid("runtime reference");
  }

  return {
    domainGenerationId: value.domainGenerationId,
    contractHash: value.contractHash,
  };
}

function isRuntimeState(value: unknown): value is RuntimeState {
  return typeof value === "string" && RUNTIME_STATES.has(value as RuntimeState);
}

function isSandboxLevel(value: unknown): value is SandboxStatus["level"] {
  return (
    typeof value === "string" && SANDBOX_LEVELS.has(value as SandboxStatus["level"])
  );
}

function isSandboxBackend(value: unknown): value is SandboxStatus["backend"] {
  return (
    typeof value === "string" &&
    SANDBOX_BACKENDS.has(value as SandboxStatus["backend"])
  );
}

function isLeaseMode(value: unknown): value is ControllerLease["mode"] {
  return typeof value === "string" && LEASE_MODES.has(value as ControllerLease["mode"]);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalid(subject: string): never {
  throw new Error(`Invalid ${subject} from DSH Sidecar.`);
}
