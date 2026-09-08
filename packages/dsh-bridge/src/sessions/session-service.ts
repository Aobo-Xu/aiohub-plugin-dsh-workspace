import type {
  ControllerLease,
  OperationAvailability,
} from "../../../runtime-facade/src/types.js";
import { BridgeCommandError } from "../controller-leases.js";

export type QueueAction =
  | { kind: "edit"; content: readonly unknown[] }
  | { kind: "remove" }
  | { kind: "steer" };

export interface SessionControlPort {
  operationAvailability(capabilityId: string): OperationAvailability;
  open?(input: { sessionId: string }): Promise<unknown>;
  list?(): Promise<unknown>;
  create?(input: { cwd?: string; workspaceId?: string; sessionId?: string; agentPreset?: string }): Promise<unknown>;
  resume?(input: { sessionId: string }): Promise<unknown>;
  rename?(input: { sessionId: string; title: string }): Promise<unknown>;
  fork?(input: { sessionId: string; atSeq?: number }): Promise<unknown>;
  delete?(input: { sessionId: string }): Promise<unknown>;
  restoreArchive?(input: { sessionId: string }): Promise<unknown>;
  restart?(input: { sessionId: string }): Promise<unknown>;
  submitPrompt?(input: unknown): Promise<unknown>;
  cancel?(input: { sessionId: string }): Promise<unknown>;
  updateQueue?(input: { sessionId: string; itemId: string; action: QueueAction }): Promise<unknown>;
}

export function createSessionControlService(options: {
  port: SessionControlPort;
  assertMutable(lease: ControllerLease): void;
}) {
  const { port, assertMutable } = options;

  function mutate<K extends keyof SessionControlPort>(
    lease: ControllerLease,
    capabilityId: string,
    method: K,
    input: unknown,
  ): unknown {
    assertMutable(lease);
    if (!port.operationAvailability(capabilityId).available || typeof port[method] !== "function") {
      throw new BridgeCommandError("CAPABILITY_UNAVAILABLE", capabilityId);
    }
    return (port[method] as (value: unknown) => unknown)(input);
  }

  return {
    async open(sessionId: string) {
      if (!port.operationAvailability("session.open").available || !port.open) {
        throw new BridgeCommandError("CAPABILITY_UNAVAILABLE", "session.open");
      }
      return await port.open({ sessionId });
    },
    async list() {
      if (!port.operationAvailability("session.list").available || !port.list) {
        throw new BridgeCommandError("CAPABILITY_UNAVAILABLE", "session.list");
      }
      return await port.list();
    },
    async create(lease: ControllerLease, input: Parameters<NonNullable<SessionControlPort["create"]>>[0]) {
      return await mutate(lease, "session.create", "create", input);
    },
    async resume(lease: ControllerLease) {
      return await mutate(lease, "session.resume", "resume", { sessionId: lease.sessionId });
    },
    async rename(lease: ControllerLease, title: string) {
      return await mutate(lease, "session.rename", "rename", { sessionId: lease.sessionId, title });
    },
    async fork(lease: ControllerLease, input: { atSeq?: number } = {}) {
      return await mutate(lease, "session.fork", "fork", { sessionId: lease.sessionId, ...input });
    },
    async delete(lease: ControllerLease) {
      return await mutate(lease, "session.delete", "delete", { sessionId: lease.sessionId });
    },
    async restoreArchive(lease: ControllerLease) {
      return await mutate(lease, "session.restore-archive", "restoreArchive", { sessionId: lease.sessionId });
    },
    async restart(lease: ControllerLease) {
      return await mutate(lease, "session.restart", "restart", { sessionId: lease.sessionId });
    },
    async submitPrompt(lease: ControllerLease, input: Record<string, unknown>) {
      return await mutate(lease, "session.submit-prompt", "submitPrompt", {
        ...input,
        sessionId: lease.sessionId,
      });
    },
    async cancel(lease: ControllerLease) {
      return await mutate(lease, "session.cancel", "cancel", { sessionId: lease.sessionId });
    },
    async updateQueue(
      lease: ControllerLease,
      input: { sessionId: string; itemId: string; action: QueueAction },
    ) {
      if (input.sessionId !== lease.sessionId) {
        throw new BridgeCommandError("LEASE_SESSION_MISMATCH");
      }
      return await mutate(lease, "session.update-queue", "updateQueue", input);
    },
  };
}
