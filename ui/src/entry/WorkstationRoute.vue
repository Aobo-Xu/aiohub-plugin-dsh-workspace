<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import WorkstationShell from "../shell/WorkstationShell.vue";
import WorkspaceHeader from "../navigation/WorkspaceHeader.vue";
import NavigationPane from "../navigation/NavigationPane.vue";
import TurnTimeline from "../timeline/TurnTimeline.vue";
import SessionComposer from "../composer/SessionComposer.vue";
import InspectorHost from "../inspector/InspectorHost.vue";
import InteractionCard from "../interactions/InteractionCard.vue";
import NeedAttention from "../interactions/NeedAttention.vue";
import {
  composeProductionFacade,
  WORKSTATION_PLUGIN_ID,
  type WorkstationFacade,
} from "../facade/compose-production";
import { PANEL_DESCRIPTORS } from "../inspector/panel-registry";
import { createRuntimeStore } from "../state/runtime-store";
import { createWorkspaceStore, type WorkspaceSummary } from "../state/workspace-store";
import { createSessionStore } from "../state/session-store";
import { createEmptyProjection } from "../state/reducers/session-reducer";
import { createInteractionStore } from "../state/interaction-store";
import { createDraftStore } from "../composer/draft-store";
import { createSideChatStore } from "../side-chat/side-chat-store";
import { createCommandGate, type GateContext } from "../composer/command-gate";
import { createSessionActions } from "../navigation/session-actions";
import { useSessionSearch } from "../navigation/use-session-search";
import type { ActionAvailability } from "../facade/capability-selectors";
import type { ControllerLease, OperationAvailability, RuntimeEvent } from "@aiohub/dsh-runtime-facade/types";
import type { InteractionView } from "../interactions/InteractionCard.vue";

// Test/preview seam: production mounts without props and composes the real
// facade, which fails closed without a compatible Host.
const props = defineProps<{ compose?: () => Promise<WorkstationFacade> }>();

const runtime = createRuntimeStore();
const workspaces = createWorkspaceStore();
const sessions = createSessionStore();
const interactions = createInteractionStore();
const drafts = createDraftStore();
const sideChats = createSideChatStore();
const collapsedSections = reactive<Record<string, boolean>>({});

let workstation: WorkstationFacade | undefined;
let unsubscribe: (() => void) | undefined;
let requestCounter = 0;

const failureReason = ref<string | undefined>();
const currentSessionId = ref<string | undefined>();
const lease = ref<ControllerLease | undefined>();

const runtimeState = computed(() => runtime.state.state);
const actionable = computed(() => runtimeState.value === "ready" || runtimeState.value === "busy");
const mutationsAvailable = computed(
  () => runtime.state.mutationsAvailable && lease.value?.mode === "controller",
);

function availabilityOf(capabilityId: string): OperationAvailability {
  if (workstation === undefined) {
    return { available: false, reason: { code: "TEMPORARILY_UNAVAILABLE" } };
  }
  const viaOperation = workstation.facade.availability(capabilityId);
  if (viaOperation.available) return viaOperation;
  // Raw negotiated capability ids (e.g. interaction.approval) are not
  // operation kinds; accept them from the negotiated descriptor set.
  const negotiated = runtime.state.negotiated.some(
    (descriptor) => descriptor.capabilityId === capabilityId,
  );
  return negotiated ? { available: true } : viaOperation;
}

const inspectorAvailability = availabilityOf;

const gateContext = computed<GateContext>(() => ({
  runtimeState: runtimeState.value,
  leaseMode: lease.value?.mode,
  lease: lease.value,
  turnActive: runtimeState.value === "busy",
  availability: availabilityOf,
}));

const gate = createCommandGate({
  context: () => gateContext.value,
  nextRequestId: () => `ws-${++requestCounter}`,
  dispatch: (command) => workstation!.facade.command(lease.value!, command),
  attachmentLimits: () => ({
    maxCount: 8,
    maxBytes: 10_485_760,
    mediaTypes: ["text/plain", "image/png", "image/jpeg", "image/webp"],
  }),
});

const sessionActions = createSessionActions({
  facade: { command: (requestedLease, command) => workstation!.facade.command(requestedLease, command) },
  lease: () => lease.value,
  context: () => gateContext.value,
  catalog: {
    remove: () => void refreshCatalogs(),
    applyRename: () => void refreshCatalogs(),
  },
  // Fail-safe until the AIO-styled confirmation dialog is wired in Task 14:
  // destructive actions are declined rather than confirmed by default.
  confirm: () => Promise.resolve(false),
  nextRequestId: () => `ws-${++requestCounter}`,
});

const search = useSessionSearch({
  store: sessions,
  runQuery: async (query: string) => {
    if (workstation === undefined) return [];
    const result = await workstation.facade.query<{ items?: unknown[] }>({
      kind: "session.search",
      input: { query },
    });
    return (result?.items ?? []) as never;
  },
});

const pendingInteractions = computed(() => Object.values(interactions.state.pending));
const attentionEntries = computed(() =>
  pendingInteractions.value.map((request) => {
    const record = request as Record<string, unknown>;
    return {
      sessionId: String(record.sessionId ?? currentSessionId.value ?? ""),
      kind: (record.kind === "question" ? "question" : "approval") as "approval" | "question",
    };
  }),
);
const attentionItems = computed(() =>
  pendingInteractions.value.map((request) => {
    const record = request as Record<string, unknown>;
    const sessionId = String(record.sessionId ?? currentSessionId.value ?? "");
    const session = sessions.state.sessions.find((candidate) => candidate.id === sessionId);
    const workspace = workspaces.state.workspaces.find(
      (candidate) => candidate.id === session?.workspaceId,
    );
    return {
      correlationId: String(record.correlationId ?? ""),
      kind: (record.kind === "question" ? "question" : "approval") as "approval" | "question",
      workspaceId: session?.workspaceId ?? "",
      workspaceName: workspace?.name,
      sessionId,
    };
  }),
);
const runningIds = computed(() =>
  Object.keys(sessions.state.open).filter((sessionId) => {
    const projection = sessions.openProjections[sessionId];
    return projection?.turns.some((turn) => turn.status === "running") === true;
  }),
);
const recentIds = computed(() => (currentSessionId.value ? [currentSessionId.value] : []));
const currentProjection = computed(() =>
  currentSessionId.value
    ? sessions.openProjections[currentSessionId.value] ?? createEmptyProjection(currentSessionId.value)
    : createEmptyProjection(""),
);

const createAvailability = computed<ActionAvailability>(() =>
  mutationsAvailable.value && availabilityOf("session.create").available
    ? { enabled: true }
    : { enabled: false, reason: { code: "CAPABILITY_UNAVAILABLE" } },
);
const searchAvailability = computed<ActionAvailability>(() =>
  availabilityOf("session.search").available
    ? { enabled: true }
    : { enabled: false, reason: { code: "CAPABILITY_UNAVAILABLE" } },
);

function toInteractionView(request: unknown): InteractionView {
  const record = (request ?? {}) as Record<string, unknown>;
  const data = (record.data ?? record) as Record<string, unknown>;
  return {
    correlationId: String(record.correlationId ?? data.correlationId ?? ""),
    kind: (record.kind ?? data.kind) === "question" ? "question" : "approval",
    scope: typeof data.scope === "string" ? data.scope : undefined,
    risk: typeof data.risk === "string" ? data.risk : undefined,
    promptText: typeof data.prompt === "string" ? data.prompt : undefined,
    operations: Array.isArray(data.operations) ? (data.operations as { id: string; summary: string }[]) : [],
    choices: Array.isArray(data.choices) ? (data.choices as string[]) : [],
    state: "pending",
  };
}

async function refreshCatalogs(): Promise<void> {
  if (workstation === undefined) return;
  try {
    const workspaceResult = await workstation.facade.query<{ items?: WorkspaceSummary[] }>({
      kind: "workspace.list",
    });
    const workspaceItems = workspaceResult?.items ?? [];
    workspaces.replaceAll(workspaceItems);
    if (workspaces.state.currentWorkspaceId === undefined && workspaceItems.length > 0) {
      // Default the navigation context to the first Host workspace so its
      // sessions are reachable; user switches always take precedence.
      workspaces.setCurrent(workspaceItems[0].id);
    }
    const sessionResult = await workstation.facade.query<{ items?: unknown[] }>({ kind: "session.list" });
    sessions.replaceCatalog((sessionResult?.items ?? []) as never);
  } catch {
    // Keep the last good catalogs; state events and explicit refresh resync.
  }
}

async function refreshOpenSession(sessionId: string): Promise<void> {
  if (workstation === undefined) return;
  try {
    const snapshot = await workstation.facade.snapshot(sessionId);
    sessions.hydrate(snapshot);
  } catch {
    // Projection stays at last good state; continuity flags resync on events.
  }
}

function onHostEvent(event: RuntimeEvent): void {
  if (event.kind.startsWith("interaction/")) {
    const record = (event.data ?? {}) as Record<string, unknown>;
    const correlationId = String(record.correlationId ?? "");
    if (event.kind === "interaction/resolved" || event.kind === "interaction/cancelled") {
      interactions.resolve({ correlationId, state: "resolved" } as never);
    } else {
      interactions.upsert({
        ...record,
        correlationId,
        kind: event.kind.includes("question") ? "question" : "approval",
      } as never);
    }
    return;
  }
  const sessionId = event.sessionId;
  if (sessionId !== undefined && sessions.state.open[sessionId] !== undefined) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const decision = sessions.applyEnvelope({
      generationId:
        typeof data.domainGenerationId === "string"
          ? data.domainGenerationId
          : workstation?.runtime.domainGenerationId ?? "",
      cursor: typeof data.cursor === "string" ? data.cursor : "",
      seq: typeof data.seq === "number" ? data.seq : 0,
      event,
    });
    if (decision === "resync-required") void refreshOpenSession(sessionId);
  }
  if (event.kind.startsWith("turn/")) void refreshCatalogs();
}

async function openSession(payload: { sessionId: string; workspaceId?: string }): Promise<void> {
  if (workstation === undefined) return;
  if (payload.workspaceId !== undefined) workspaces.setCurrent(payload.workspaceId);
  currentSessionId.value = payload.sessionId;
  const previousLease = lease.value;
  try {
    lease.value = await workstation.facade.acquireSession({
      ...workstation.runtime,
      sessionId: payload.sessionId,
      mode: "controller",
    } as never);
    sessions.applyLease(payload.sessionId, lease.value);
    await refreshOpenSession(payload.sessionId);
  } catch {
    // Focus stays read-only: never acquire control implicitly on failure.
    lease.value = previousLease?.sessionId === payload.sessionId ? previousLease : undefined;
  }
}

async function onSubmit(payload: { text: string }): Promise<void> {
  const outcome = await gate.submit({ text: payload.text });
  if (outcome.ok && currentSessionId.value !== undefined) {
    drafts.markSubmitted(currentSessionId.value, true);
    await refreshOpenSession(currentSessionId.value);
  }
}

async function onRespond(payload: { correlationId: string; choice: string }): Promise<void> {
  const pending = interactions.state.pending[payload.correlationId];
  if (pending === undefined) return;
  const view = toInteractionView(pending);
  const outcome = await gate.respondInteraction(
    { correlationId: view.correlationId, kind: view.kind, choices: view.choices, state: "pending" },
    payload.choice,
  );
  if (outcome.ok) {
    interactions.resolve({ correlationId: view.correlationId, state: "resolved" } as never);
  }
}

function onNavigateAttention(target: { workspaceId: string; sessionId: string }): void {
  void openSession({ sessionId: target.sessionId, workspaceId: target.workspaceId });
}

onMounted(async () => {
  runtime.applyRuntimeState("loading" as never);
  try {
    workstation = await (props.compose ?? composeProductionFacade)();
    runtime.applyRuntimeInfo({
      state: workstation.state,
      negotiated: workstation.negotiated,
      mutationsAvailable: workstation.mutationsAvailable,
      runtime: workstation.runtime,
    });
    unsubscribe = workstation.facade.subscribe(onHostEvent);
    await refreshCatalogs();
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    runtime.applyRuntimeState(
      (code === "CONTRACT_MISMATCH" || code === "REQUIRED_CAPABILITY_MISSING"
        ? "incompatible"
        : "unavailable") as never,
    );
    failureReason.value = code ?? (error as Error | undefined)?.message ?? "HOST_UNAVAILABLE";
  }
});

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  sideChats.releaseAll();
  void workstation?.shutdown();
  workstation = undefined;
});
</script>

<template>
  <WorkstationShell
    :runtime-state="String(runtimeState)"
    :mutations-available="mutationsAvailable"
    :unavailable-reason="failureReason"
    :interaction-active="pendingInteractions.length > 0"
  >
    <template #nav>
      <NeedAttention :items="attentionItems" @navigate="onNavigateAttention" />
      <WorkspaceHeader
        :workspaces="workspaces.state.workspaces"
        :current-workspace-id="workspaces.state.currentWorkspaceId"
        :create-availability="createAvailability"
        :search-availability="searchAvailability"
        @switch-workspace="workspaces.setCurrent($event)"
        @search="search.submit($event)"
        @create-session="sessionActions.create()"
      />
      <NavigationPane
        :workspaces="workspaces.state.workspaces"
        :current-workspace-id="workspaces.state.currentWorkspaceId"
        :sessions="sessions.state.sessions"
        :attention="attentionEntries"
        :running="runningIds"
        :recent="recentIds"
        :collapsed-sections="collapsedSections"
        @toggle-section="collapsedSections[$event] = !collapsedSections[$event]"
        @open-session="openSession"
        @switch-workspace="workspaces.setCurrent($event)"
      />
    </template>

    <TurnTimeline :projection="currentProjection" />

    <template #interaction>
      <InteractionCard
        v-for="pending in pendingInteractions"
        :key="pending.correlationId"
        :interaction="toInteractionView(pending)"
        @respond="onRespond"
      />
    </template>

    <template #composer>
      <SessionComposer
        :session-id="currentSessionId ?? WORKSTATION_PLUGIN_ID"
        :can-submit="mutationsAvailable && actionable"
        :busy="runtimeState === 'busy'"
        :queue-available="availabilityOf('session.updateQueue').available"
        :steer-available="availabilityOf('session.steer').available"
        :observer="actionable && !mutationsAvailable"
        @submit="onSubmit"
      />
    </template>

    <template #inspector>
      <InspectorHost
        :session-id="currentSessionId ?? ''"
        :descriptors="PANEL_DESCRIPTORS"
        :availability="inspectorAvailability"
        :narrow="false"
      />
    </template>
  </WorkstationShell>
</template>
