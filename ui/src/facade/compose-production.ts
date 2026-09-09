import { AioSidecarTransport, type AioPluginProxy } from "@aiohub/dsh-runtime-facade/aio-sidecar-transport";
import { SidecarRuntimeFacade } from "@aiohub/dsh-runtime-facade/runtime-facade";
import type {
  CapabilityDescriptor,
  InitializeInput,
  RuntimeFacade,
  RuntimeRef,
  RuntimeState,
} from "@aiohub/dsh-runtime-facade/types";
import { FacadeCompositionError } from "./errors";

// Replaced by the ui/vite.config.ts define with generated/protocol.sha256.
// In unit tests the expected hash is always injected explicitly.
declare const __DSH_CONTRACT_HASH__: string | undefined;

export const WORKSTATION_PLUGIN_ID = "dsh-coding-workspace";

/** Minimum read capabilities the workstation shell cannot degrade below. */
export const REQUIRED_READ_CAPABILITIES: readonly string[] = [
  "workspace.list",
  "session.list",
  "session.open",
  "session.history",
  "session.snapshot",
];

/**
 * Probe for the read-only partial state: session-management mutations are
 * the first capability class a reduced Host drops. Per-action gating still
 * flows through capability-selectors; this flag only drives the shell's
 * read-only presentation.
 */
export const PARTIAL_MUTATE_PROBE = "session.create";

export type ActivePluginLookup = (pluginId: string) => unknown;

export type WorkstationFacade = {
  readonly facade: RuntimeFacade;
  readonly runtime: RuntimeRef;
  readonly state: RuntimeState;
  readonly negotiated: readonly CapabilityDescriptor[];
  readonly mutationsAvailable: boolean;
  shutdown(): Promise<void>;
};

export type ComposeProductionOptions = {
  pluginId?: string;
  getActivePlugin?: ActivePluginLookup;
  expectedContractHash?: string;
  initialize?: Partial<InitializeInput>;
  requiredReadCapabilities?: readonly string[];
};

const REQUIRED_PROXY_METHODS: readonly string[] = [
  "initialize",
  "acquireSession",
  "transferController",
  "command",
  "snapshot",
  "shutdown",
  "disable",
  "onSidecarEvent",
];

/**
 * Instantiates the plugin-owned RuntimeFacade from the active PluginProxy
 * and validates the negotiated contract identity before returning. Fails
 * closed: no fallback adapter, no test double, no version sniffing.
 */
export async function composeProductionFacade(
  options: ComposeProductionOptions = {},
): Promise<WorkstationFacade> {
  const pluginId = options.pluginId ?? WORKSTATION_PLUGIN_ID;
  const getActivePlugin = options.getActivePlugin ?? defaultGetActivePlugin;

  const proxy = await getActivePlugin(pluginId);
  if (proxy === undefined || proxy === null) {
    throw new FacadeCompositionError({
      code: "PLUGIN_NOT_ACTIVE",
      message: `Plugin ${pluginId} is not active (missing, disabled or broken).`,
    });
  }
  for (const method of REQUIRED_PROXY_METHODS) {
    if (typeof Reflect.get(proxy, method) !== "function") {
      throw new FacadeCompositionError({
        code: "PLUGIN_PROXY_INVALID",
        message: `Plugin ${pluginId} proxy does not expose ${method}.`,
      });
    }
  }

  const facade = new SidecarRuntimeFacade(new AioSidecarTransport(proxy as AioPluginProxy));

  let result;
  try {
    result = await facade.initialize({
      hostApiVersion: 3,
      platform: "win32-x64",
      pluginDataDir: "",
      prewarm: false,
      ...options.initialize,
    });
  } catch (error) {
    throw new FacadeCompositionError({
      code: "INITIALIZE_FAILED",
      message: `Plugin ${pluginId} failed to initialize the DSH runtime.`,
      cause: error,
    });
  }

  const expected = options.expectedContractHash ?? injectedContractHash();
  if (expected === undefined || result.contractHash !== expected) {
    throw new FacadeCompositionError({
      code: "CONTRACT_MISMATCH",
      message: "Negotiated contract identity does not match the plugin-pinned contract.",
    });
  }

  const required = options.requiredReadCapabilities ?? REQUIRED_READ_CAPABILITIES;
  const missing = required.filter(
    (capabilityId) => !facade.availability(capabilityId).available,
  );
  if (missing.length > 0) {
    throw new FacadeCompositionError({
      code: "REQUIRED_CAPABILITY_MISSING",
      message: `Host did not negotiate required read capabilities: ${missing.join(", ")}.`,
      missingCapabilities: missing,
    });
  }

  return {
    facade,
    runtime: {
      domainGenerationId: result.domainGenerationId,
      contractHash: result.contractHash,
    },
    state: result.state,
    negotiated: facade.capabilities(),
    mutationsAvailable: facade.availability(PARTIAL_MUTATE_PROBE).available,
    shutdown: () => facade.shutdown("user-stop"),
  };
}

function injectedContractHash(): string | undefined {
  return typeof __DSH_CONTRACT_HASH__ === "string" ? __DSH_CONTRACT_HASH__ : undefined;
}

async function defaultGetActivePlugin(pluginId: string): Promise<unknown> {
  const { pluginManager } = await import("aiohub-sdk");
  return pluginManager.getActivePlugin(pluginId);
}
