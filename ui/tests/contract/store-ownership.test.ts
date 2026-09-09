import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createUiStore, PERSISTED_PREFERENCE_KEYS } from "../../src/state/ui-store";
import { createSessionStore } from "../../src/state/session-store";
import { createRuntimeStore } from "../../src/state/runtime-store";
import { createWorkspaceStore } from "../../src/state/workspace-store";
import { createInteractionStore } from "../../src/state/interaction-store";
import { COLD_SNAPSHOT } from "../fixtures/session-events";

const stateDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/state");

function storeFiles(): string[] {
  return readdirSync(stateDir)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(stateDir, entry));
}

describe("UI preference persistence ownership", () => {
  it("persists only the allowlisted preference object", async () => {
    const writes: { pluginId: string; key: string; value: unknown }[] = [];
    const store = createUiStore({
      pluginId: "dsh-coding-workspace",
      debounceMs: 0,
      config: {
        getValue: async () => undefined,
        setValue: async (pluginId: string, key: string, value: unknown) => {
          writes.push({ pluginId, key, value });
        },
      },
    });

    store.setPaneWidth("inspector", 320);
    store.toggleSection("running", false);
    store.setLocale("zh-CN");
    store.setCloseWarningSuppressed(true);
    await store.flush();

    expect(writes).toHaveLength(1);
    expect(writes[0].pluginId).toBe("dsh-coding-workspace");
    expect(writes[0].key).toBe("workstationUi");
    const persisted = writes[0].value as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual([...PERSISTED_PREFERENCE_KEYS].sort());
    expect(persisted.paneWidths).toEqual({ inspector: 320 });
    expect(persisted.collapsedSections).toEqual({ running: false });
    expect(persisted.locale).toBe("zh-CN");
    expect(persisted.closeWarningSuppressed).toBe(true);
  });

  it("loads persisted preferences filtered to the allowlist", async () => {
    const store = createUiStore({
      pluginId: "dsh-coding-workspace",
      debounceMs: 0,
      config: {
        getValue: async <T,>() =>
          ({
            paneWidths: { left: 280 },
            collapsedSections: {},
            locale: "en",
            closeWarningSuppressed: false,
            sessions: [{ id: "leak" }],
            drafts: { text: "leak" },
            sideChats: [1],
          }) as unknown as T,
        setValue: async () => {},
      },
    });

    await store.load();
    const serialized = JSON.parse(JSON.stringify(store.preferences)) as Record<string, unknown>;
    for (const forbidden of ["sessions", "drafts", "sideChats", "interactions", "attachments", "hostEvents"]) {
      expect(forbidden in serialized).toBe(false);
    }
    expect(serialized.paneWidths).toEqual({ left: 280 });
  });

  it("never touches persistence from non-preference stores", () => {
    for (const file of storeFiles()) {
      const name = path.basename(file);
      const text = readFileSync(file, "utf8");
      if (name === "ui-store.ts") {
        expect(text).toContain("pluginConfigService");
        continue;
      }
      expect(/pluginConfigService|setValue|aiohub-sdk/.test(text), `${name} must not persist`).toBe(false);
    }
  });

  it("keeps Host projections replaceable rather than persisted", async () => {
    const runtime = createRuntimeStore();
    const workspaces = createWorkspaceStore();
    const sessions = createSessionStore();
    const interactions = createInteractionStore();

    sessions.hydrate(COLD_SNAPSHOT);
    expect(sessions.openProjections[COLD_SNAPSHOT.sessionId].turns).toHaveLength(1);

    runtime.applyRuntimeInfo({ state: "ready", negotiated: [], mutationsAvailable: true });
    expect(runtime.state.state).toBe("ready");

    workspaces.replaceAll([{ id: "ws-1", name: "one" }]);
    expect(workspaces.state.workspaces).toHaveLength(1);

    const decision = interactions.resolve({
      domainGenerationId: "gen-fixture-1",
      contractHash: "test-contract-hash",
      sessionId: "session-fixture-1",
      correlationId: "i-1",
      reason: "answered",
    });
    expect(decision).toBe("resolved");
    expect(interactions.resolve({
      domainGenerationId: "gen-fixture-1",
      contractHash: "test-contract-hash",
      sessionId: "session-fixture-1",
      correlationId: "i-1",
      reason: "cancelled",
    })).toBe("duplicate");
    expect(interactions.state.resolved["i-1"].reason).toBe("answered");
  });

  it("keeps reducers free of framework and persistence imports", () => {
    const reducersDir = path.join(stateDir, "reducers");
    for (const entry of readdirSync(reducersDir).filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(path.join(reducersDir, entry), "utf8");
      expect(/from "vue"|pluginConfigService|aiohub-sdk/.test(text), `${entry} must stay pure`).toBe(false);
    }
  });
});
