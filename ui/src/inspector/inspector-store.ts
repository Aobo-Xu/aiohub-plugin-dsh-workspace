import { reactive } from "vue";

export type ResourceRef = { kind: string; id: string; revision?: string };

export type InspectorTab = {
  id: string;
  panelType: string;
  sessionId: string;
  title: string;
  resourceRef?: ResourceRef;
  pinned: boolean;
};

export type PanelDescriptor = {
  panelType: string;
  title: string;
  singleton?: boolean;
  maxInstances?: number;
  capabilityId?: string;
  /** Generic fallback panels are never offered in creation menus. */
  generic?: boolean;
};

export type OpenPanelRequest = {
  panelType: string;
  resourceRef?: ResourceRef;
  title?: string;
};

export type OpenOutcome =
  | { ok: true; tabId: string }
  | { ok: false; reason: { code: "CAPABILITY_UNAVAILABLE" | "INSTANCE_LIMIT" | "UNKNOWN_PANEL" } };

export type AvailabilityFn = (capabilityId: string) => { available: boolean };

export type InspectorStoreOptions = {
  descriptors: readonly PanelDescriptor[];
  availability: AvailabilityFn;
};

type SessionState = { tabs: InspectorTab[]; activeTabId: string | undefined };

/**
 * Per-session, in-memory inspector tabs. Nothing here persists; only pane
 * width/collapse preferences may persist elsewhere (ui-store). Tabs never
 * move across sessions, and closing the last tab returns to the chooser
 * without touching Host work.
 */
export function createInspectorStore(options: InspectorStoreOptions) {
  const sessions = reactive<Record<string, SessionState>>({});
  let activeSession = "";
  let nextTabId = 0;

  function sessionState(sessionId: string): SessionState {
    let state = sessions[sessionId];
    if (state === undefined) {
      state = { tabs: [], activeTabId: undefined };
      sessions[sessionId] = state;
    }
    return state;
  }

  function tabsFor(sessionId: string): InspectorTab[] {
    return sessionState(sessionId).tabs;
  }

  function activeTabId(sessionId: string): string | undefined {
    return sessionState(sessionId).activeTabId;
  }

  function openPanel(sessionId: string, request: OpenPanelRequest): OpenOutcome {
    const descriptor = options.descriptors.find((candidate) => candidate.panelType === request.panelType);
    if (descriptor === undefined) {
      return { ok: false, reason: { code: "UNKNOWN_PANEL" } };
    }
    if (descriptor.capabilityId !== undefined && !options.availability(descriptor.capabilityId).available) {
      return { ok: false, reason: { code: "CAPABILITY_UNAVAILABLE" } };
    }
    const state = sessionState(sessionId);
    const matches = (tab: InspectorTab): boolean => {
      if (tab.panelType !== request.panelType) return false;
      if (request.resourceRef === undefined) return descriptor.singleton === true;
      return tab.resourceRef?.kind === request.resourceRef.kind && tab.resourceRef?.id === request.resourceRef.id;
    };
    const existing = state.tabs.find(matches);
    if (existing !== undefined) {
      state.activeTabId = existing.id;
      return { ok: true, tabId: existing.id };
    }
    const limit = descriptor.maxInstances ?? (descriptor.singleton === true ? 1 : Number.POSITIVE_INFINITY);
    const count = state.tabs.filter((tab) => tab.panelType === request.panelType).length;
    if (count >= limit) {
      return { ok: false, reason: { code: "INSTANCE_LIMIT" } };
    }
    nextTabId += 1;
    const tab: InspectorTab = {
      id: `tab-${nextTabId}`,
      panelType: request.panelType,
      sessionId,
      title: request.title ?? (request.resourceRef ? `${descriptor.title}: ${request.resourceRef.id}` : descriptor.title),
      ...(request.resourceRef ? { resourceRef: request.resourceRef } : {}),
      pinned: false,
    };
    state.tabs.push(tab);
    state.activeTabId = tab.id;
    return { ok: true, tabId: tab.id };
  }

  function closeTab(sessionId: string, tabId: string): void {
    const state = sessionState(sessionId);
    const index = state.tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;
    state.tabs.splice(index, 1);
    if (state.activeTabId === tabId) {
      const next = state.tabs[Math.min(index, state.tabs.length - 1)];
      state.activeTabId = next?.id;
    }
  }

  function togglePin(sessionId: string, tabId: string): void {
    const tab = sessionState(sessionId).tabs.find((candidate) => candidate.id === tabId);
    if (tab !== undefined) tab.pinned = !tab.pinned;
  }

  function switchSession(sessionId: string): void {
    activeSession = sessionId;
  }

  return {
    tabsFor,
    activeTabId,
    openPanel,
    closeTab,
    togglePin,
    switchSession,
    activeSessionId: () => activeSession,
    chooserVisible: (sessionId: string) => sessionState(sessionId).tabs.length === 0,
  };
}

export type InspectorStore = ReturnType<typeof createInspectorStore>;
