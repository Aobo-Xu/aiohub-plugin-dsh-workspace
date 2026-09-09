/**
 * The single raw-capability-to-feature mapping for the workstation UI.
 * Vue components and stores consume feature ids only; they never branch on
 * DSH versions, release strings or raw capability names.
 */
export type WorkstationFeatureArea =
  | "workspace"
  | "session"
  | "turn"
  | "terminal"
  | "preset"
  | "dynamic"
  | "attachment"
  | "context";

export type WorkstationFeature = {
  readonly featureId: string;
  readonly capabilityId: string;
  readonly mode: "read" | "mutate";
  readonly area: WorkstationFeatureArea;
};

const FEATURES: readonly WorkstationFeature[] = [
  { featureId: "workspace.list", capabilityId: "workspace.list", mode: "read", area: "workspace" },
  { featureId: "workspace.open", capabilityId: "workspace.open", mode: "read", area: "workspace" },
  { featureId: "workspace.create", capabilityId: "workspace.create", mode: "mutate", area: "workspace" },
  { featureId: "workspace.rename", capabilityId: "workspace.rename", mode: "mutate", area: "workspace" },
  { featureId: "workspace.remove", capabilityId: "workspace.remove", mode: "mutate", area: "workspace" },
  { featureId: "workspace.archiveSession", capabilityId: "workspace.archiveSession", mode: "mutate", area: "workspace" },
  { featureId: "session.list", capabilityId: "session.list", mode: "read", area: "session" },
  { featureId: "session.open", capabilityId: "session.open", mode: "read", area: "session" },
  { featureId: "session.create", capabilityId: "session.create", mode: "mutate", area: "session" },
  { featureId: "session.search", capabilityId: "session.search", mode: "read", area: "session" },
  { featureId: "session.history", capabilityId: "session.history", mode: "read", area: "session" },
  { featureId: "session.resume", capabilityId: "session.resume", mode: "mutate", area: "session" },
  { featureId: "session.rename", capabilityId: "session.rename", mode: "mutate", area: "session" },
  { featureId: "session.restoreArchive", capabilityId: "session.restoreArchive", mode: "mutate", area: "session" },
  { featureId: "session.delete", capabilityId: "session.delete", mode: "mutate", area: "session" },
  { featureId: "session.fork", capabilityId: "session.fork", mode: "mutate", area: "session" },
  { featureId: "session.acquire", capabilityId: "session.acquire", mode: "mutate", area: "session" },
  { featureId: "session.transfer-controller", capabilityId: "session.transfer-controller", mode: "mutate", area: "session" },
  { featureId: "session.submit-prompt", capabilityId: "session.submit-prompt", mode: "mutate", area: "turn" },
  { featureId: "session.updateQueue", capabilityId: "session.updateQueue", mode: "mutate", area: "turn" },
  { featureId: "session.steer", capabilityId: "session.steer", mode: "mutate", area: "turn" },
  { featureId: "session.cancel", capabilityId: "session.cancel", mode: "mutate", area: "turn" },
  { featureId: "session.restart", capabilityId: "session.restart", mode: "mutate", area: "turn" },
  { featureId: "session.snapshot", capabilityId: "session.snapshot", mode: "read", area: "turn" },
  { featureId: "terminal.open", capabilityId: "terminal.open", mode: "mutate", area: "terminal" },
  { featureId: "terminal.read", capabilityId: "terminal.read", mode: "read", area: "terminal" },
  { featureId: "terminal.list", capabilityId: "terminal.list", mode: "read", area: "terminal" },
  { featureId: "terminal.input", capabilityId: "terminal.input", mode: "mutate", area: "terminal" },
  { featureId: "terminal.resize", capabilityId: "terminal.resize", mode: "mutate", area: "terminal" },
  { featureId: "terminal.interrupt", capabilityId: "terminal.interrupt", mode: "mutate", area: "terminal" },
  { featureId: "terminal.close", capabilityId: "terminal.close", mode: "mutate", area: "terminal" },
  { featureId: "preset.catalog", capabilityId: "preset.catalog", mode: "read", area: "preset" },
  { featureId: "preset.select", capabilityId: "preset.select", mode: "mutate", area: "preset" },
  { featureId: "dynamic.host.define", capabilityId: "dynamic.host.define", mode: "mutate", area: "dynamic" },
  { featureId: "dynamic.host.run", capabilityId: "dynamic.host.run", mode: "mutate", area: "dynamic" },
  { featureId: "dynamic.host.update", capabilityId: "dynamic.host.update", mode: "mutate", area: "dynamic" },
  { featureId: "dynamic.host.stop", capabilityId: "dynamic.host.stop", mode: "mutate", area: "dynamic" },
  { featureId: "dynamic.host.undefine", capabilityId: "dynamic.host.undefine", mode: "mutate", area: "dynamic" },
  { featureId: "dynamic.host.inventory", capabilityId: "dynamic.host.inventory", mode: "read", area: "dynamic" },
  { featureId: "dynamic.host.diagnostics", capabilityId: "dynamic.host.diagnostics", mode: "read", area: "dynamic" },
  { featureId: "attachment.limits", capabilityId: "attachment.limits", mode: "read", area: "attachment" },
  { featureId: "context.summary", capabilityId: "context.summary", mode: "read", area: "context" },
];

export const WORKSTATION_FEATURES: readonly WorkstationFeature[] = Object.freeze(FEATURES);

const BY_ID = new Map(FEATURES.map((feature) => [feature.featureId, feature]));

export function featureById(featureId: string): WorkstationFeature | undefined {
  return BY_ID.get(featureId);
}
