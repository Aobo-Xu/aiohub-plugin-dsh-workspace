import type {
  CapabilityDescriptor,
  OperationAvailability,
} from "../../../runtime-facade/src/types.js";

/**
 * Provenance identity of one release adapter. The tag and commit identify the
 * pinned upstream fixture; they are recorded for support/provenance output and
 * must never be used as a selection input (see `selectRuntimeByEvidence` in
 * scripts/runtime/resolve-runtime.ts for the same rule on the runtime lock).
 */
export type AdapterIdentity = {
  adapterId: string;
  releaseTag: string;
  releaseCommit: string;
  schemaVersion: number;
  serviceEvidence: readonly string[];
  /**
   * Executable-runtime evidence is provenance, never adapter-selection input.
   * Source/API compatibility fixtures must stay visibly pending when an
   * official runtime artifact is unavailable.
   */
  executableValidation?:
    | { status: "passed"; artifactSha256: string }
    | { status: "pending"; reason: "official-wheel-unavailable" };
};

/**
 * Result of probing a DSH release through its official public surface. Only
 * public service names and schema identity may appear here — nothing derived
 * from version strings or private modules.
 */
export type AdapterProbe = {
  ok: boolean;
  schemaVersion: number;
  services: readonly string[];
  capabilities: readonly CapabilityDescriptor[];
};

/**
 * Capabilities settled with the runtime after a successful probe. Fail-closed:
 * an adapter that cannot prove an operation reports it unavailable instead of
 * improvising a private fallback.
 */
export type NegotiatedCapabilities = {
  schemaVersion: number;
  capabilities: readonly CapabilityDescriptor[];
};

/**
 * Minimal port seam for Task 4. Each port exposes operation-level availability
 * grounded in the settled capability set; concrete operations are implemented
 * by the release adapters of Task 5 (rc.1) and Task 6 (alpha.2).
 */
export interface AdapterPort {
  operationAvailability(operationId: string): OperationAvailability;
}

export type WorkspacePort = AdapterPort;
export type SessionPort = AdapterPort;
export type ProjectionPort = AdapterPort;
export type InteractionPort = AdapterPort;
export type ArtifactPort = AdapterPort;
export type TerminalPort = AdapterPort;
export type PresetPort = AdapterPort;
export type DynamicRuntimePort = AdapterPort;

/**
 * Input of the official DSH session open/migration path. The payload is
 * release-specific; adapters validate it against their settled schema.
 */
export type MigrationInput = {
  sessionId: string;
  payload: unknown;
};

export type MigrationResult =
  | {
      status: "migrated";
      sessionId: string;
      schemaVersion: number;
    }
  | {
      status: "not-migrated";
      reason: OperationAvailability["reason"];
    };

/**
 * Stable seam between the Host and one DSH release. This is the exact public
 * shape the composition root consumes; release differences stay behind it.
 */
export interface DshReleaseAdapter {
  readonly identity: AdapterIdentity;
  probe(): Promise<AdapterProbe>;
  settle(): Promise<NegotiatedCapabilities>;
  workspaces: WorkspacePort;
  sessions: SessionPort;
  projections: ProjectionPort;
  interactions: InteractionPort;
  artifacts: ArtifactPort;
  terminals: TerminalPort;
  presets: PresetPort;
  dynamicRuntime: DynamicRuntimePort;
  migrate(input: MigrationInput): Promise<MigrationResult>;
  dispose(): Promise<void>;
}

/**
 * Public service/schema evidence presented to the registry. Mirrors the
 * runtime-lock selector contract: capability/schema identity only — a version
 * prefix is never a valid selection input.
 */
export type AdapterSelectionEvidence = {
  schemaVersion: number;
  services: readonly string[];
};

/**
 * Selection failure code recorded by the registry when no registered adapter
 * factory is satisfied by the presented evidence.
 */
export const ADAPTER_INCOMPATIBLE = "ADAPTER_INCOMPATIBLE";
