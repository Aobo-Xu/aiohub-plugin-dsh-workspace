import type { AvailabilityFn, PanelDescriptor } from "./inspector-store";

/**
 * Capability-driven panel catalog. Panel types are open for Host-declared
 * extensions; the generic descriptor is the bounded fallback for resources
 * without a specialized viewer and is never offered in creation menus.
 */
export const PANEL_DESCRIPTORS: readonly PanelDescriptor[] = Object.freeze([
  { panelType: "details", title: "Details", singleton: true },
  { panelType: "tasks", title: "Tasks & Context", capabilityId: "context.summary" },
  { panelType: "files", title: "Files", capabilityId: "file.read" },
  { panelType: "diff", title: "Diff Review", maxInstances: 4 },
  { panelType: "statistics", title: "Statistics", singleton: true, capabilityId: "session.statistics" },
  { panelType: "goal", title: "Goal", singleton: true, capabilityId: "goal.manage" },
  { panelType: "terminal", title: "Terminal", maxInstances: 3, capabilityId: "terminal.open" },
  { panelType: "subagent", title: "Subagent", maxInstances: 3, capabilityId: "subagent.inspect" },
  { panelType: "side-chat", title: "Side Chat", maxInstances: 3 },
  { panelType: "generic", title: "Resource", generic: true },
]);

export function availablePanelTypes(
  descriptors: readonly PanelDescriptor[],
  availability: AvailabilityFn,
): PanelDescriptor[] {
  return descriptors.filter(
    (descriptor) =>
      descriptor.generic !== true &&
      (descriptor.capabilityId === undefined || availability(descriptor.capabilityId).available),
  );
}
