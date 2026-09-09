import { reactive } from "vue";

export type WorkspaceSummary = {
  id: string;
  name: string;
  path?: string;
  archived?: boolean;
};

export type WorkspaceStoreState = {
  workspaces: WorkspaceSummary[];
  currentWorkspaceId: string | undefined;
};

/** Workspace catalog projection owned by the Host; replaced, never edited. */
export function createWorkspaceStore() {
  const state = reactive<WorkspaceStoreState>({
    workspaces: [],
    currentWorkspaceId: undefined,
  });

  function replaceAll(workspaces: readonly WorkspaceSummary[]): void {
    state.workspaces = [...workspaces];
  }

  function setCurrent(workspaceId: string | undefined): void {
    state.currentWorkspaceId = workspaceId;
  }

  return { state, replaceAll, setCurrent };
}
