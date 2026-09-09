<script setup lang="ts">
import { ref } from "vue";
import type { ActionAvailability } from "../facade/capability-selectors";
import type { WorkspaceSummary } from "../state/workspace-store";

const props = defineProps<{
  workspaces: readonly WorkspaceSummary[];
  currentWorkspaceId?: string;
  createAvailability: ActionAvailability;
  searchAvailability: ActionAvailability;
}>();

const emit = defineEmits<{
  "switch-workspace": [workspaceId: string];
  search: [query: string];
  "create-session": [];
}>();

const query = ref("");

function onSwitch(event: Event): void {
  const target = event.target as HTMLSelectElement | null;
  if (target?.value) {
    emit("switch-workspace", target.value);
  }
}

function onSearchSubmit(): void {
  const trimmed = query.value.trim();
  if (trimmed.length > 0) {
    emit("search", trimmed);
  }
}

function disabledTitle(availability: ActionAvailability): string | undefined {
  return availability.enabled ? undefined : `Unavailable: ${availability.reason.code}`;
}
</script>

<template>
  <header class="ws-header">
    <select
      class="ws-workspace-switch"
      data-testid="workspace-switch"
      aria-label="Current workspace"
      :value="props.currentWorkspaceId"
      @change="onSwitch"
    >
      <option v-for="workspace in props.workspaces" :key="workspace.id" :value="workspace.id">
        {{ workspace.name }}
      </option>
    </select>
    <form class="ws-search" role="search" @submit.prevent="onSearchSubmit">
      <input
        v-model="query"
        type="search"
        data-testid="session-search"
        aria-label="Search sessions"
        :disabled="!props.searchAvailability.enabled"
        :title="disabledTitle(props.searchAvailability)"
      />
    </form>
    <button
      type="button"
      data-testid="new-session"
      :disabled="!props.createAvailability.enabled"
      :aria-disabled="props.createAvailability.enabled ? undefined : 'true'"
      :title="disabledTitle(props.createAvailability)"
      @click="emit('create-session')"
    >New session</button>
  </header>
</template>

<style scoped>
.ws-header {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px;
  border-bottom: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
}
.ws-workspace-switch {
  max-width: 160px;
}
.ws-search {
  flex: 1;
  min-width: 0;
}
.ws-search input {
  width: 100%;
}
</style>
