import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRc1Fixture, RC1_SERVICE_EVIDENCE, RC1_SESSION_FORMAT_VERSION, SessionId } from "./fixtures/rc1-runtime.js";
import type { Rc1Fixture } from "./fixtures/rc1-runtime.js";
import { createRc1Adapter, registerRc1Adapter, RC1_ADAPTER_ID, RC1_SCHEMA_VERSION } from "../src/adapters/rc1.js";
import { createAdapterRegistry } from "../src/adapters/registry.js";
import { createDshHost } from "../src/host/create-host.js";
import { REQUIRED_SERVICES } from "../src/public-services.js";
import type { SessionId as DshSessionId } from "@deepseek-ai/dsh-session";

const roots: Rc1Fixture[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((fixture) => fixture.dispose()));
});

async function withFixture(
  run: (fixture: Rc1Fixture, cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "dsh-rc1-adapter-")));
  const fixture = await createRc1Fixture({ cwd });
  roots.push(fixture);
  await run(fixture, cwd);
}

function approvalDecisionFixture(fixture: Rc1Fixture, outcome: "allowed-once" | "rejected"): void {
  fixture.ctx.on("approval/request", () => Promise.resolve(outcome));
}

describe("rc1 adapter identity and probe", () => {
  it("probes the official rc.1 service settlement without version-name inference", async () => {
    await withFixture(async (fixture) => {
      const adapter = createRc1Adapter({ runtime: fixture });
      roots.push({
        ...fixture,
        dispose: adapter.dispose,
      } as Rc1Fixture);
      roots.pop();

      const probe = await adapter.probe();

      expect(probe.ok).toBe(true);
      expect(probe.schemaVersion).toBe(RC1_SCHEMA_VERSION);
      for (const service of RC1_SERVICE_EVIDENCE) {
        expect(probe.services).toContain(service);
      }
      expect(probe.capabilities.length).toBeGreaterThan(0);
      // Provenance carries the locked release identity but never feeds decisions.
      expect(adapter.identity.releaseTag).toBe("dsh-v0.1.2-rc.1");
      expect(adapter.identity.adapterId).toBe(RC1_ADAPTER_ID);
      expect(adapter.identity.serviceEvidence).toEqual([...RC1_SERVICE_EVIDENCE]);
      expect(typeof adapter.identity.releaseCommit).toBe("string");
    });
  });

  it("settles capabilities grounded in the probed public services", async () => {
    await withFixture(async (fixture) => {
      const adapter = createRc1Adapter({ runtime: fixture });

      const probe = await adapter.probe();
      const settled = await adapter.settle();

      expect(settled.schemaVersion).toBe(probe.schemaVersion);
      const capabilityIds = settled.capabilities.map((descriptor) => descriptor.capabilityId);
      expect(new Set(capabilityIds).size).toBe(capabilityIds.length);
      expect(capabilityIds).toContain("workspace.create");
      expect(capabilityIds).toContain("session.create");
      expect(capabilityIds).toContain("session.snapshot");
      expect(capabilityIds).toContain("session.history");
      expect(capabilityIds).toContain("session.submit-prompt");
      expect(capabilityIds).toContain("session.cancel");
      expect(capabilityIds).toContain("interaction.approval");
      expect(capabilityIds).toContain("terminal.open");
      await adapter.dispose();
    });
  });
});

describe("rc1 adapter through the host composition root", () => {
  it("creates and opens a workspace via the official WorkspaceController", async () => {
    await withFixture(async (fixture, cwd) => {
      const adapter = createRc1Adapter({ runtime: fixture });
      const host = createDshHost({ adapter });
      const settled = await adapter.settle();
      host.applyNegotiation(settled.capabilities);

      const workspaces = host.port("workspaces");
      expect(workspaces.operationAvailability("workspace.create")).toEqual({ available: true });

      const created = await (workspaces as unknown as {
        create(input: { path: string }): Promise<{ workspaceId: string; path: string; created: boolean }>;
      }).create({ path: cwd });

      expect(created.created).toBe(true);
      expect(created.path).toBe(cwd);
      expect(created.workspaceId.length).toBeGreaterThan(0);
      await adapter.dispose();
    });
  });

  it("creates, opens, and pages real session history through the official SessionController", async () => {
    await withFixture(async (fixture) => {
      const adapter = createRc1Adapter({ runtime: fixture });
      const host = createDshHost({ adapter });
      const settled = await adapter.settle();
      host.applyNegotiation(settled.capabilities);
      fixture.useAgentFactory();

      const sessions = host.port("sessions");
      const ops = sessions as unknown as {
        create(input: { cwd?: string }): Promise<{ sessionId: string }>;
        history(input: { sessionId: string; throughSeq: number }): Promise<{
          records: ReadonlyArray<{ event: { type: string; seq: number } }>;
          hasMore: boolean;
        }>;
        snapshot(input: { sessionId: string }): Promise<{
          type: string;
          header: { version: number; id: string };
          cursor: number;
        }>;
        submitPrompt(input: {
          sessionId: string;
          requestId: string;
          content: ReadonlyArray<{ type: "text"; text: string }>;
        }): Promise<{ accepted: boolean }>;
        cancel(input: { sessionId: string }): Promise<{ accepted: boolean }>;
      };

      const created = await ops.create({ cwd: process.cwd() });
      expect(created.sessionId.length).toBeGreaterThan(0);

      const followUp = await ops.submitPrompt({
        sessionId: created.sessionId,
        requestId: "rc1-adapter-request-1",
        content: [{ type: "text", text: "hello from the aio hub host" }],
      });
      expect(followUp.accepted).toBe(true);

      const snapshot = await ops.snapshot({ sessionId: created.sessionId });
      expect(snapshot.type).toBe("snapshot");
      expect(snapshot.header.version).toBe(RC1_SESSION_FORMAT_VERSION);
      expect(snapshot.header.id).toBe(created.sessionId);
      // The fixture agent delivers the prompt as one durable user/message
      // event (seq 0), so the page cursor is 0; page through that seq.
      expect(snapshot.cursor).toBe(0);

      const history = await ops.history({ sessionId: created.sessionId, throughSeq: snapshot.cursor });
      expect(history.records.length).toBeGreaterThan(0);
      expect(history.records.at(-1)?.event.type).toBe("user/message");

      const cancelled = await ops.cancel({ sessionId: created.sessionId });
      expect(cancelled.accepted).toBe(true);
      await adapter.dispose();
    });
  });

  it("resolves an approval interaction through the official ApprovalService audit pair", async () => {
    await withFixture(async (fixture) => {
      approvalDecisionFixture(fixture, "allowed-once");
      fixture.useAgentFactory();
      const adapter = createRc1Adapter({ runtime: fixture });
      const host = createDshHost({ adapter });
      const settled = await adapter.settle();
      host.applyNegotiation(settled.capabilities);

      // ApprovalService encloses each ask in an open turn: create the
      // session through the controller, then open its turn before resolving.
      const created = await fixture.services.sessionController.create({ cwd: process.cwd() });
      const attached = fixture.ctx.sessions.get(created.sessionId as never) as { append: (type: string, data: unknown) => void } | undefined;
      expect(attached).toBeDefined();
      attached!.append("turn/start", {});

      const interactions = host.port("interactions");
      const resolved = await (interactions as unknown as {
        resolveApproval(input: {
          sessionId: string;
          toolName: string;
          decision: "allow-once" | "deny";
        }): Promise<{ outcome: string; correlationId: string }>;
      }).resolveApproval({ sessionId: created.sessionId, toolName: "fixture-tool", decision: "allow-once" });

      expect(resolved.outcome).toBe("allowed-once");
      expect(resolved.correlationId.length).toBeGreaterThan(0);

      // The official audit pair is appended to the session log.
      const types = attached!.session === undefined
        ? (fixture.ctx.sessions.get(created.sessionId as never) as unknown as { snapshotEvents: () => Array<{ type: string }> }).snapshotEvents().map((event) => event.type)
        : [];
      expect(types).toContain("approval/asked");
      expect(types).toContain("approval/decided");
      await adapter.dispose();
    });
  });

  it("opens, reads, and closes a terminal handle through the official TerminalSessionService", async () => {
    await withFixture(async (fixture) => {
      fixture.useAgentFactory();
      const adapter = createRc1Adapter({ runtime: fixture });
      const host = createDshHost({ adapter });
      const settled = await adapter.settle();
      host.applyNegotiation(settled.capabilities);

      const terminals = host.port("terminals");
      const ops = terminals as unknown as {
        open(input: { sessionId: string; type?: string }): Promise<{ handleId: string; motd: string }>;
        read(input: { sessionId: string; handleId: string }): Promise<{ text: string }>;
        close(input: { sessionId: string; handleId: string }): Promise<{ closed: boolean }>;
      };

      const created = await fixture.services.sessionController.create({ cwd: process.cwd() });
      const opened = await ops.open({ sessionId: created.sessionId });
      expect(opened.motd).toContain("fixture motd");
      expect(opened.handleId.length).toBeGreaterThan(0);

      const read = await ops.read({ sessionId: created.sessionId, handleId: opened.handleId });
      expect(read.text).toContain("fixture pty");

      const closed = await ops.close({ sessionId: created.sessionId, handleId: opened.handleId });
      expect(closed.closed).toBe(true);
      await adapter.dispose();
    });
  });

  it("reports unavailable operations instead of improvising, and disposes the runtime context", async () => {
    await withFixture(async (fixture) => {
      const adapter = createRc1Adapter({ runtime: fixture });
      const host = createDshHost({ adapter });
      const settled = await adapter.settle();
      host.applyNegotiation(settled.capabilities);
      fixture.useAgentFactory();

      // rc.1 exposes no dynamic-runtime install surface: fail closed at the port.
      const dynamic = host.port("dynamicRuntime");
      expect(dynamic.operationAvailability("dynamicRuntime.install")).toEqual({
        available: false,
        reason: { code: "CAPABILITY_NOT_NEGOTIATED" },
      });

      // One live session created through the official controller proves the
      // runtime context is live before dispose drains it.
      const created = await fixture.services.sessionController.create({ cwd: process.cwd() });
      const sessionId = SessionId(created.sessionId) as DshSessionId;
      expect(fixture.ctx.sessions.get(sessionId)).toBeDefined();
      // Disposing through the host clears its negotiated capability set and
      // disposes the adapter's runtime binding.
      await host.dispose();
      expect(host.capabilities()).toEqual([]);
      expect(host.availability("session.create")).toEqual({
        available: false,
        reason: { code: "CAPABILITY_NOT_NEGOTIATED" },
      });
    });
  });
});

describe("rc1 adapter registry selection", () => {
  it("registers a factory selected by public evidence and rejects foreign evidence", async () => {
    await withFixture(async (fixture) => {
      const registry = createAdapterRegistry();
      registerRc1Adapter(registry, { runtime: fixture });

      const host = await registry.select({
        schemaVersion: RC1_SCHEMA_VERSION,
        services: [...REQUIRED_SERVICES, ...RC1_SERVICE_EVIDENCE],
      });
      expect(host).not.toBeNull();
      expect(host?.adapterIdentity.adapterId).toBe(RC1_ADAPTER_ID);

      const foreign = createAdapterRegistry();
      registerRc1Adapter(foreign, { runtime: fixture });
      const rejected = await foreign.select({
        schemaVersion: RC1_SCHEMA_VERSION + 1,
        services: [...RC1_SERVICE_EVIDENCE],
      });
      expect(rejected).toBeNull();
      expect(foreign.lastSelection).toMatchObject({ status: "incompatible" });
      await fixture.dispose();
    });
  });
});
