import type { OperationAvailability } from "../../../runtime-facade/src/types.js";
import { BridgeCommandError } from "../controller-leases.js";

export type WorkspaceView = {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds?: readonly string[];
  createdAt?: string;
  updatedAt?: string;
};

export interface WorkspaceControlPort {
  operationAvailability(capabilityId: string): OperationAvailability;
  follow?(signal: AbortSignal): AsyncIterable<{
    type: "baseline" | "upsert" | "remove" | "order" | "archived";
    value?: { items: readonly WorkspaceView[]; archivedSessionIds: readonly string[] };
    workspace?: WorkspaceView;
    workspaceId?: string;
    workspaceIds?: readonly string[];
    archivedSessionIds?: readonly string[];
  }> | Promise<AsyncIterable<{
    type: "baseline" | "upsert" | "remove" | "order" | "archived";
    value?: { items: readonly WorkspaceView[]; archivedSessionIds: readonly string[] };
    workspace?: WorkspaceView;
    workspaceId?: string;
    workspaceIds?: readonly string[];
    archivedSessionIds?: readonly string[];
  }>>;
  create?(input: { path: string }): Promise<WorkspaceView & { created: boolean }>;
  rename?(input: { workspaceId: string; title: string }): Promise<WorkspaceView>;
  delete?(input: { workspaceId: string }): Promise<{ deleted: true }>;
  archiveSession?(input: { sessionId: string }): Promise<{ archivedSessionIds: readonly string[] }>;
}

export function createWorkspaceService(options: { port: WorkspaceControlPort }) {
  const { port } = options;

  return {
    async list() {
      if (!port.operationAvailability("workspace.follow").available || !port.follow) {
        throw new BridgeCommandError("CAPABILITY_UNAVAILABLE", "workspace.follow");
      }
      const stream = await port.follow(new AbortController().signal);
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || first.value.type !== "baseline" || first.value.value === undefined) {
        throw new BridgeCommandError("INVALID_WORKSPACE_BASELINE");
      }
      return first.value.value;
    },
    async open(workspaceId: string) {
      const baseline = await this.list();
      const workspace = baseline.items.find((item) => item.workspaceId === workspaceId);
      if (workspace === undefined) {
        throw new BridgeCommandError("UNKNOWN_WORKSPACE");
      }
      return workspace;
    },
    async register(path: string) {
      if (!path) throw new BridgeCommandError("INVALID_WORKSPACE_PATH");
      return await invoke(port, "workspace.create", "create", { path });
    },
    async rename(workspaceId: string, title: string) {
      return await invoke(port, "workspace.rename", "rename", { workspaceId, title });
    },
    async remove(workspaceId: string) {
      // The official DSH WorkspaceController delete contract removes only the
      // registration. Workspace files, Git state, and Sessions stay owned by
      // their original stores; the bridge performs no filesystem operation.
      return await invoke(port, "workspace.delete", "delete", { workspaceId });
    },
    async archiveSession(sessionId: string) {
      return await invoke(port, "workspace.archive-session", "archiveSession", {
        sessionId,
      });
    },
  };
}

function invoke<
  K extends "create" | "rename" | "delete" | "archiveSession",
>(
  port: WorkspaceControlPort,
  capabilityId: string,
  method: K,
  input: Parameters<NonNullable<WorkspaceControlPort[K]>>[0],
): ReturnType<NonNullable<WorkspaceControlPort[K]>> {
  if (!port.operationAvailability(capabilityId).available || !port[method]) {
    throw new BridgeCommandError("CAPABILITY_UNAVAILABLE", capabilityId);
  }
  const operation = port[method] as (value: typeof input) => ReturnType<NonNullable<WorkspaceControlPort[K]>>;
  return operation(input);
}
