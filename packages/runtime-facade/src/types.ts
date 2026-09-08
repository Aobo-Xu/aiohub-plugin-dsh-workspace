export type PlatformKey =
  | "win32-x64"
  | "linux-x64"
  | "darwin-arm64"
  | "linux-arm64";

export type RuntimeState =
  | "stopped"
  | "starting"
  | "loading"
  | "ready"
  | "maintenance"
  | "upgrading"
  | "recovering"
  | "busy"
  | "stopping"
  | "crashed"
  | "unavailable"
  | "incompatible";

export type SandboxStatus = {
  level: "full" | "partial";
  backend: "bwrap" | "landlock" | "seatbelt" | "restricted-token";
  reason?: string;
};

export type RuntimeRef = {
  domainGenerationId: string;
  contractHash: string;
};

export type ControllerLease = RuntimeRef & {
  sessionId: string;
  leaseId: string;
  mode: "controller" | "observer";
};

export type InitializeInput = {
  hostApiVersion: 3;
  platform: PlatformKey;
  pluginDataDir: string;
  prewarm: boolean;
};

export type InitializeResult = RuntimeRef & {
  state: RuntimeState;
  capabilities: readonly string[];
  sandbox: SandboxStatus;
};

export type AcquireSessionInput = RuntimeRef & {
  sessionId: string;
  viewId: string;
  requestedMode: "controller" | "observer";
};

export type TransferControllerInput = ControllerLease & {
  targetViewId: string;
};

export type RuntimeCommand = {
  kind: string;
  requestId?: string;
  sessionId?: string;
  turnId?: string;
  input?: unknown;
};

export type RuntimeEvent = {
  kind: string;
  sessionId?: string;
  turnId?: string;
  data: unknown;
};

export type SessionSnapshot = RuntimeRef & {
  source: "dsh";
  provenance: {
    adapterId: string;
    releaseCommit?: string;
  };
  sessionId: string;
  cursor: string;
  seq: number;
  durableFacts: readonly RuntimeEvent[];
  workspaceId?: string;
  lineage?: { parentSessionId?: string; forkedAtSeq?: number };
};

export type OperationMode = "read" | "mutate" | "observe";

export type CapabilityStability = "stable" | "experimental";

export type CapabilityDescriptor = {
  capabilityId: string;
  schemaRevision: number;
  stability: CapabilityStability;
  mode: OperationMode;
};

export type UnavailableReasonCode =
  | "CAPABILITY_NOT_NEGOTIATED"
  | "ENVIRONMENT_UNSUPPORTED"
  | "TEMPORARILY_UNAVAILABLE";

export type UnavailableReason = {
  code: UnavailableReasonCode;
};

export type OperationAvailability = {
  available: boolean;
  reason?: UnavailableReason;
};

export type CapabilityHostError = {
  code: string;
  capabilityId?: string;
  retryable: boolean;
  indeterminate: boolean;
  detail?: unknown;
};

export class CapabilityDeniedError extends Error {
  public readonly code: string;
  public readonly capabilityId?: string;
  public readonly retryable: boolean;
  public readonly indeterminate: boolean;
  public readonly detail?: unknown;

  public constructor(error: CapabilityHostError) {
    super(error.code);
    this.name = "CapabilityDeniedError";
    this.code = error.code;
    this.capabilityId = error.capabilityId;
    this.retryable = error.retryable;
    this.indeterminate = error.indeterminate;
    this.detail = error.detail;
  }
}

export type InteractionRequest = RuntimeRef & {
  sessionId: string;
  correlationId: string;
  kind: "approval" | "question";
  data: unknown;
};

export type InteractionResolved = RuntimeRef & {
  sessionId: string;
  correlationId: string;
  reason: "answered" | "cancelled" | "transferred" | "restarted" | "timeout";
};

export type ProfileDiagnostic = {
  code: string;
  field?: string;
  message: string;
};

export type AioLlmProfile = {
  id: string;
  protocol: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
};

export type TurnConfigSnapshot = {
  snapshotVersion: 1;
  routeId: string;
  model: string;
  parameters: Readonly<Record<string, unknown>>;
  promptContribution: string;
  workspace: string;
  permission: "workspace-write" | "full-access";
  sandboxPolicy: "ask" | "deny";
};

export interface SidecarTransport {
  request<T>(method: string, params: unknown): Promise<T>;
  onEvent(callback: (value: unknown) => void): () => void;
  kill(): Promise<void>;
}

export interface RuntimeFacade {
  initialize(input: InitializeInput): Promise<InitializeResult>;
  acquireSession(input: AcquireSessionInput): Promise<ControllerLease>;
  transferController(input: TransferControllerInput): Promise<ControllerLease>;
  command<T>(lease: ControllerLease, command: RuntimeCommand): Promise<T>;
  query<T>(command: RuntimeCommand): Promise<T>;
  capabilities(): readonly CapabilityDescriptor[];
  availability(capabilityId: string): OperationAvailability;
  snapshot(sessionId: string, cursor?: string): Promise<SessionSnapshot>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  shutdown(reason: "plugin-disabled" | "aio-exit" | "user-stop"): Promise<void>;
}

export const DSH_CAPABILITY = Object.freeze({
  id: "execution-domain:dsh",
  version: 1,
  stability: "stable" as const,
});
