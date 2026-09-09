<script setup lang="ts">
import { computed } from "vue";
import ProjectionSection from "./ProjectionSection.vue";
import SessionRow, { type SessionRowLabels } from "./SessionRow.vue";
import type { SessionSummary } from "../state/session-store";
import type { WorkspaceSummary } from "../state/workspace-store";

export type AttentionEntry = { sessionId: string; kind: "approval" | "question" };

const props = defineProps<{
  workspaces: readonly WorkspaceSummary[];
  currentWorkspaceId?: string;
  sessions: readonly SessionSummary[];
  attention: readonly AttentionEntry[];
  running: readonly string[];
  recent: readonly string[];
  collapsedSections: Record<string, boolean>;
  sessionLabels?: Record<string, SessionRowLabels>;
}>();

const emit = defineEmits<{
  "toggle-section": [sectionId: string];
  "open-session": [payload: { sessionId: string; workspaceId?: string }];
  "switch-workspace": [workspaceId: string];
}>();

const byId = computed(() => new Map(props.sessions.map((session) => [session.id, session])));

function resolve(sessionId: string): SessionSummary {
  return byId.value.get(sessionId) ?? { id: sessionId, title: sessionId };
}

/** Statuses aggregate across projections: every row of one Host session shows
 * the same facts, never a per-projection copy. */
const statusesById = computed(() => {
  const map = new Map<string, string[]>();
  const push = (id: string, label: string) => {
    const list = map.get(id) ?? [];
    if (!list.includes(label)) list.push(label);
    map.set(id, list);
  };
  for (const id of props.running) push(id, "Running");
  for (const entry of props.attention) push(entry.sessionId, "Needs attention");
  return map;
});

type SectionEntry = { session: SessionSummary };

const sections = computed(() => [
  {
    id: "need-attention",
    title: "Need Attention",
    entries: props.attention.map((entry) => ({ session: resolve(entry.sessionId) })),
  },
  {
    id: "running",
    title: "Running",
    entries: props.running.map((id) => ({ session: resolve(id) })),
  },
  {
    id: "current-workspace",
    title: "Current Workspace",
    entries: props.sessions
      .filter((session) => session.workspaceId === props.currentWorkspaceId && session.archived !== true)
      .map((session) => ({ session })),
  },
  {
    id: "recently-visited",
    title: "Recently Visited",
    entries: props.recent.map((id) => ({ session: resolve(id) })),
  },
  { id: "workspace-management", title: "Workspace Management", entries: [] as SectionEntry[] },
  {
    id: "archived",
    title: "Archived",
    entries: props.sessions.filter((session) => session.archived === true).map((session) => ({ session })),
  },
]);

function onOpen(session: SessionSummary): void {
  if (session.workspaceId !== undefined && session.workspaceId !== props.currentWorkspaceId) {
    // Cross-workspace navigation switches context; it never cancels other
    // running sessions.
    emit("switch-workspace", session.workspaceId);
  }
  emit("open-session", { sessionId: session.id, workspaceId: session.workspaceId });
}
</script>

<template>
  <nav class="ws-navigation" aria-label="Workspace and session navigation">
    <section
      v-for="section in sections"
      :key="section.id"
      data-testid="nav-section"
      :data-section="section.id"
    >
      <ProjectionSection
        :section-id="section.id"
        :title="section.title"
        :collapsed="collapsedSections[section.id] === true"
        @toggle="emit('toggle-section', section.id)"
      >
        <template v-if="section.id === 'workspace-management'">
          <li v-for="workspace in workspaces" :key="workspace.id" class="ws-workspace-entry">
            <button
              type="button"
              data-testid="workspace-entry"
              :data-workspace-id="workspace.id"
              :aria-current="workspace.id === currentWorkspaceId ? 'true' : undefined"
              @click="emit('switch-workspace', workspace.id)"
            >{{ workspace.name }}</button>
          </li>
        </template>
        <SessionRow
          v-for="entry in section.entries"
          :key="`${section.id}:${entry.session.id}`"
          :session="entry.session"
          :statuses="statusesById.get(entry.session.id) ?? []"
          :labels="sessionLabels?.[entry.session.id]"
          @open="onOpen"
        />
      </ProjectionSection>
    </section>
  </nav>
</template>

<style scoped>
.ws-navigation {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ws-workspace-entry {
  list-style: none;
  padding: 4px 8px;
}
.ws-workspace-entry button {
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: var(--text-color, inherit);
}
</style>
