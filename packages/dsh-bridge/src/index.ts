export {
  BridgeNotImplementedError,
  BridgeStartupError,
} from "./errors.js";

export {
  assertPublicServices,
  REQUIRED_SERVICES,
} from "./public-services.js";
export type { RequiredServiceName } from "./public-services.js";

export { createSessionService } from "./sessions.js";
export { createSessionControlService } from "./sessions/session-service.js";
export { createSessionSearchService } from "./sessions/search-service.js";
export { createWorkspaceService } from "./workspaces/workspace-service.js";
export { createControllerLeaseService } from "./controller-leases.js";
export { createInteractionService } from "./interactions.js";
export { createEventService } from "./events.js";
export { createSnapshotRecovery } from "./snapshot-recovery.js";
export { createAuthoritativeSnapshot } from "./projections/snapshot.js";
export { normalizeHostEvents } from "./projections/event-normalizer.js";
export type { HostEventInput, NormalizedHostEvent } from "./projections/event-normalizer.js";
export { createContextSummary } from "./projections/context-summary.js";
export type { ContextSummary, ContextSummaryInput } from "./projections/context-summary.js";
export { createAttachmentStager } from "./artifacts/attachments.js";
export type { AttachmentLimits, StagedAttachment } from "./artifacts/attachments.js";
export { createDiffArtifactService } from "./artifacts/diffs.js";
export type { DiffArtifact, DiffReviewInput } from "./artifacts/diffs.js";
export { normalizePresenter } from "./presenters/normalize-presenter.js";
export type { PresenterInput, PresenterRecord } from "./presenters/normalize-presenter.js";
export { normalizeExecutionProjection } from "./presenters/execution-projection.js";
export type { ExecutionProjectionInput } from "./presenters/execution-projection.js";
export { createTerminalService } from "./terminals/terminal-service.js";
export type { TerminalHandle } from "./terminals/terminal-service.js";
export { createPresetService } from "./presets/preset-service.js";
export { createDynamicPackageService } from "./dynamic-runtime/dynamic-package-service.js";
export { createMaintenanceService } from "./maintenance/maintenance-service.js";
export { createExternalToolProvider } from "./external-tools/provider.js";
export type {
  CatalogSnapshot,
  ExternalToolProvider,
  ProviderDescriptor,
  ToolInvocationEvent,
  ToolInvocationRequest,
} from "./external-tools/provider.js";
export { createBoundedQueue } from "./bounded-queue.js";
export { createProfileAdapter } from "./profile-adapter.js";
export { createCredentialProvider } from "./credential-provider.js";
export { createPromptContribution } from "./prompt-contribution.js";
export { createLiteralPlaceholderCodec } from "./literal-placeholder-codec.js";
export { createTurnSnapshot } from "./turn-snapshot.js";
export { createPolicy } from "./policy.js";

export type {
  AdapterIdentity,
  AdapterPort,
  AdapterProbe,
  AdapterSelectionEvidence,
  ArtifactPort,
  DynamicRuntimePort,
  InteractionPort,
  MigrationInput,
  MigrationResult,
  NegotiatedCapabilities,
  PresetPort,
  ProjectionPort,
  SessionPort,
  TerminalPort,
  WorkspacePort,
  DshReleaseAdapter,
} from "./adapters/types.js";
export { ADAPTER_INCOMPATIBLE } from "./adapters/types.js";

export type {
  AdapterRegistry,
  AdapterSelectionOutcome,
  AdapterFactoryRegistration,
  SettledAdapterHost,
} from "./adapters/registry.js";
export { createAdapterRegistry } from "./adapters/registry.js";

export type { DshHost, HostPortName } from "./host/create-host.js";
export { createDshHost } from "./host/create-host.js";
export type {
  CreateRuntimeHostOptions,
  RuntimeHost,
  RuntimeHostState,
} from "./host/runtime-host.js";
export { createRuntimeHost } from "./host/runtime-host.js";

export {
  createRc1Adapter,
  registerRc1Adapter,
  RC1_ADAPTER_ID,
  RC1_SCHEMA_VERSION,
  RC1_SERVICE_EVIDENCE,
  CapabilityUnavailableError,
} from "./adapters/rc1.js";
export type { Rc1RuntimeSurface } from "./adapters/rc1.js";

export {
  createAlpha2Adapter,
  registerAlpha2Adapter,
  ALPHA2_ADAPTER_ID,
  ALPHA2_SCHEMA_VERSION,
  ALPHA2_SERVICE_EVIDENCE,
} from "./adapters/alpha2.js";
export type {
  Alpha2AdapterOptions,
  Alpha2CompatibilitySnapshot,
  Alpha2RuntimeSurface,
} from "./adapters/alpha2.js";
