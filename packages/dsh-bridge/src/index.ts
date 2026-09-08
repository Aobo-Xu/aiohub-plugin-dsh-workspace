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
export { createControllerLeaseService } from "./controller-leases.js";
export { createInteractionService } from "./interactions.js";
export { createEventService } from "./events.js";
export { createSnapshotRecovery } from "./snapshot-recovery.js";
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

export {
  createRc1Adapter,
  registerRc1Adapter,
  RC1_ADAPTER_ID,
  RC1_SCHEMA_VERSION,
  RC1_SERVICE_EVIDENCE,
  CapabilityUnavailableError,
} from "./adapters/rc1.js";
export type { Rc1RuntimeSurface } from "./adapters/rc1.js";
