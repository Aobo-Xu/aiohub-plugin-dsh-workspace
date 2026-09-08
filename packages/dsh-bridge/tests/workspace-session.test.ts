import { describe, expect, it, vi } from "vitest";
import { createControllerLeaseService } from "../src/controller-leases.js";
import { createSessionControlService } from "../src/sessions/session-service.js";
import { createSessionSearchService } from "../src/sessions/search-service.js";
import { createWorkspaceService } from "../src/workspaces/workspace-service.js";

const runtimeRef = {
  domainGenerationId: "generation-1",
  contractHash: "contract-1",
} as const;

describe("authoritative workspace control", () => {
  it("lists the authoritative baseline and opens one stable workspace identity", async () => {
    const follow = vi.fn(async function* () {
      yield {
        type: "baseline" as const,
        value: {
          items: [
            {
              workspaceId: "workspace-1",
              path: "C:/work/project",
              title: "Project",
              sessionIds: [],
              createdAt: "2026-09-08T00:00:00.000Z",
              updatedAt: "2026-09-08T00:00:00.000Z",
            },
          ],
          archivedSessionIds: [],
        },
      };
    });
    const service = createWorkspaceService({
      port: {
        operationAvailability: () => ({ available: true }),
        follow,
      },
    });

    await expect(service.list()).resolves.toMatchObject({
      items: [{ workspaceId: "workspace-1", path: "C:/work/project" }],
      archivedSessionIds: [],
    });
    await expect(service.open("workspace-1")).resolves.toMatchObject({
      workspaceId: "workspace-1",
      title: "Project",
    });
    expect(follow).toHaveBeenCalledTimes(2);
  });

  it("keeps the DSH workspace identity and delegates safe registration removal", async () => {
    const create = vi.fn(async ({ path }: { path: string }) => ({
      workspaceId: "dsh-workspace-7",
      path: `canonical:${path}`,
      title: "Workspace",
      created: true,
    }));
    const remove = vi.fn(async () => ({ deleted: true as const }));
    const service = createWorkspaceService({
      port: {
        operationAvailability: () => ({ available: true }),
        create,
        delete: remove,
      },
    });

    await expect(service.register("C:/work/project")).resolves.toMatchObject({
      workspaceId: "dsh-workspace-7",
      path: "canonical:C:/work/project",
    });
    await expect(service.remove("dsh-workspace-7")).resolves.toEqual({
      deleted: true,
    });
    expect(remove).toHaveBeenCalledWith({ workspaceId: "dsh-workspace-7" });
  });

  it("fails closed instead of simulating an unsupported workspace mutation", async () => {
    const rename = vi.fn();
    const service = createWorkspaceService({
      port: {
        operationAvailability: () => ({
          available: false,
          reason: { code: "CAPABILITY_NOT_NEGOTIATED" },
        }),
        rename,
      },
    });

    await expect(service.rename("workspace-1", "New title")).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capabilityId: "workspace.rename",
    });
    expect(rename).not.toHaveBeenCalled();
  });
});

describe("authoritative session control", () => {
  it("allows observer cold-open but fences queue mutations", async () => {
    const open = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      header: { id: sessionId, version: 0, createdAt: 1 },
      events: [],
    }));
    const updateQueue = vi.fn(async () => ({ accepted: true as const }));
    const leases = createControllerLeaseService();
    const observer = await leases.acquire({
      ...runtimeRef,
      sessionId: "session-1",
      viewId: "view-observer",
      requestedMode: "observer",
    });
    const service = createSessionControlService({
      port: {
        operationAvailability: () => ({ available: true }),
        open,
        updateQueue,
      },
      assertMutable: leases.assertMutable,
    });

    await expect(service.open("session-1")).resolves.toMatchObject({
      header: { id: "session-1" },
    });
    await expect(
      service.updateQueue(observer, {
        sessionId: "session-1",
        itemId: "item-1",
        action: { kind: "remove" },
      }),
    ).rejects.toMatchObject({ code: "OBSERVER_MUTATION" });
    expect(open).toHaveBeenCalledOnce();
    expect(updateQueue).not.toHaveBeenCalled();
  });

  it("routes supported lifecycle operations and rejects absent ones", async () => {
    const rename = vi.fn(async () => ({ title: "Renamed", seq: 9 }));
    const fork = vi.fn(async () => ({ sessionId: "session-child" }));
    const leases = createControllerLeaseService();
    const controller = await leases.acquire({
      ...runtimeRef,
      sessionId: "session-1",
      viewId: "view-controller",
      requestedMode: "controller",
    });
    const service = createSessionControlService({
      port: {
        operationAvailability(capabilityId: string) {
          return capabilityId === "session.delete"
            ? { available: false, reason: { code: "CAPABILITY_NOT_NEGOTIATED" } }
            : { available: true };
        },
        rename,
        fork,
      },
      assertMutable: leases.assertMutable,
    });

    await expect(service.rename(controller, "Renamed")).resolves.toEqual({
      title: "Renamed",
      seq: 9,
    });
    await expect(service.fork(controller, { atSeq: 8 })).resolves.toEqual({
      sessionId: "session-child",
    });
    await expect(service.delete(controller)).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capabilityId: "session.delete",
    });
  });

  it("injects the leased session into prompt and routes queue controls independently", async () => {
    const submitPrompt = vi.fn(async (input: unknown) => ({ accepted: true as const, input }));
    const updateQueue = vi.fn(async (input: unknown) => ({ accepted: true as const, input }));
    const cancel = vi.fn(async (input: unknown) => ({ accepted: true as const, input }));
    const leases = createControllerLeaseService();
    const controller = await leases.acquire({
      ...runtimeRef,
      sessionId: "session-1",
      viewId: "view-controller",
      requestedMode: "controller",
    });
    const service = createSessionControlService({
      port: {
        operationAvailability: () => ({ available: true }),
        submitPrompt,
        updateQueue,
        cancel,
      },
      assertMutable: leases.assertMutable,
    });

    await service.submitPrompt(controller, {
      requestId: "request-1",
      content: [{ type: "text", text: "hello" }],
      mode: "steer",
    });
    await service.updateQueue(controller, {
      sessionId: controller.sessionId,
      itemId: "queue-1",
      action: { kind: "remove" },
    });
    await service.cancel(controller);

    expect(submitPrompt).toHaveBeenCalledWith({
      sessionId: "session-1",
      requestId: "request-1",
      content: [{ type: "text", text: "hello" }],
      mode: "steer",
    });
    expect(updateQueue).toHaveBeenCalledWith({
      sessionId: "session-1",
      itemId: "queue-1",
      action: { kind: "remove" },
    });
    expect(cancel).toHaveBeenCalledWith({ sessionId: "session-1" });
  });

  it("fails closed for restart when the adapter does not advertise it", async () => {
    const leases = createControllerLeaseService();
    const controller = await leases.acquire({
      ...runtimeRef,
      sessionId: "session-1",
      viewId: "view-controller",
      requestedMode: "controller",
    });
    const service = createSessionControlService({
      port: {
        operationAvailability: () => ({ available: false, reason: { code: "CAPABILITY_NOT_NEGOTIATED" } }),
      },
      assertMutable: leases.assertMutable,
    });

    await expect(service.restart(controller)).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capabilityId: "session.restart",
    });
  });
});

describe("cancelable search and history", () => {
  it("discards a superseded search result even when the adapter ignores abort", async () => {
    const resolvers: Array<(value: { items: string[]; hasMore: boolean }) => void> = [];
    const search = vi.fn(
      () =>
        new Promise<{ items: string[]; hasMore: boolean }>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const service = createSessionSearchService({
      port: {
        operationAvailability: () => ({ available: true }),
        search,
      },
    });

    const first = service.search("old");
    const second = service.search("new");
    resolvers[0]?.({ items: ["old-result"], hasMore: false });
    resolvers[1]?.({ items: ["new-result"], hasMore: false });

    await expect(first).resolves.toMatchObject({ status: "superseded", requestGeneration: 1 });
    await expect(second).resolves.toMatchObject({
      status: "current",
      requestGeneration: 2,
      value: { items: ["new-result"] },
    });
    expect(search.mock.calls[0]?.[1].aborted).toBe(true);
  });

  it("carries the requested history cursor without accepting stale pages", async () => {
    const history = vi.fn(async (input: { beforeSeq?: number }) => ({
      records: [input.beforeSeq],
      hasMore: false,
    }));
    const service = createSessionSearchService({
      port: {
        operationAvailability: () => ({ available: true }),
        history,
      },
    });

    await expect(
      service.history({ sessionId: "session-1", throughSeq: 20, beforeSeq: 10 }),
    ).resolves.toMatchObject({
      status: "current",
      cursor: { throughSeq: 20, beforeSeq: 10 },
      value: { records: [10] },
    });
  });
});
