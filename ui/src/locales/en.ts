export type WorkstationStrings = {
  nav: {
    needAttention: string;
    running: string;
    currentWorkspace: string;
    recentlyVisited: string;
    workspaceManagement: string;
    archived: string;
  };
  status: {
    running: string;
    completed: string;
    failed: string;
    cancelled: string;
    interrupted: string;
  };
  composer: {
    send: string;
    queue: string;
    steer: string;
    emptyHint: string;
    requestControl: string;
  };
  sideChat: {
    newChat: string;
    ask: string;
    copy: string;
    insertDraft: string;
    staleBadge: string;
    refresh: string;
    closeWarning: string;
  };
  inspector: {
    openPanel: string;
    addPanel: string;
    closeTab: string;
    pinTab: string;
  };
};

export const en: WorkstationStrings = {
  nav: {
    needAttention: "Need Attention",
    running: "Running",
    currentWorkspace: "Current Workspace",
    recentlyVisited: "Recently Visited",
    workspaceManagement: "Workspace Management",
    archived: "Archived",
  },
  status: {
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
  },
  composer: {
    send: "Send",
    queue: "Queue",
    steer: "Steer",
    emptyHint: "Add non-blank text or an admitted attachment before sending.",
    requestControl: "Request control",
  },
  sideChat: {
    newChat: "New side chat",
    ask: "Ask",
    copy: "Copy",
    insertDraft: "Insert as draft",
    staleBadge: "Context stale — newer main-task context available",
    refresh: "Refresh context",
    closeWarning: "will be deleted and cannot be recovered",
  },
  inspector: {
    openPanel: "Open a panel",
    addPanel: "Add inspector panel",
    closeTab: "Close tab",
    pinTab: "Pin tab",
  },
};
