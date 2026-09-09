import type { InspectorStore, OpenOutcome } from "./inspector-store";

export type ResourceRequest = {
  kind: string;
  id: string;
  revision?: string;
  intent: "open";
};

const KIND_TO_PANEL: Readonly<Record<string, string>> = {
  details: "details",
  tasks: "tasks",
  file: "files",
  diff: "diff",
  terminal: "terminal",
  subagent: "subagent",
  statistics: "statistics",
  goal: "goal",
};

/**
 * Single capability-driven entry point for message links, tool artifacts,
 * files, Diffs and future Host resources. Focuses a compatible existing panel
 * or creates one while preserving provenance. Unknown resource types fall
 * back to the bounded generic panel; the navigator never reads or executes
 * the resource itself.
 */
export function navigateResource(
  store: InspectorStore,
  sessionId: string,
  request: ResourceRequest,
): OpenOutcome {
  const panelType = KIND_TO_PANEL[request.kind] ?? "generic";
  return store.openPanel(sessionId, {
    panelType,
    resourceRef: {
      kind: request.kind,
      id: request.id,
      ...(request.revision === undefined ? {} : { revision: request.revision }),
    },
    title: `${request.kind}:${request.id}`,
  });
}
