<script setup lang="ts">
import type { SessionSummary } from "../state/session-store";

export type SessionRowLabels = {
  workspaceName?: string;
  source?: string;
  model?: string;
};

defineProps<{
  session: SessionSummary;
  statuses?: readonly string[];
  labels?: SessionRowLabels;
  active?: boolean;
}>();

defineEmits<{ open: [session: SessionSummary] }>();
</script>

<template>
  <li
    class="ws-session-row"
    :data-session-id="session.id"
    :aria-current="active === true ? 'true' : undefined"
    tabindex="0"
    role="button"
    @click="$emit('open', session)"
    @keydown.enter="$emit('open', session)"
  >
    <span class="ws-row-title">{{ session.title }}</span>
    <span
      v-for="status in statuses ?? []"
      :key="status"
      class="ws-row-status"
      data-testid="row-status"
      :aria-label="status"
    >{{ status }}</span>
    <span v-if="labels?.workspaceName" class="ws-row-label" data-testid="row-workspace">{{ labels.workspaceName }}</span>
    <span v-if="labels?.source" class="ws-row-label" data-testid="row-source">{{ labels.source }}</span>
    <span v-if="labels?.model" class="ws-row-label" data-testid="row-model">{{ labels.model }}</span>
  </li>
</template>

<style scoped>
.ws-session-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 6px 8px;
  cursor: pointer;
  list-style: none;
  color: var(--text-color, inherit);
}
.ws-session-row:hover {
  background: var(--fill-color-light, rgba(0, 0, 0, 0.04));
}
.ws-session-row:focus-visible {
  outline: 2px solid var(--color-primary, #409eff);
  outline-offset: -2px;
}
.ws-row-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-row-status {
  font-size: 0.75em;
  padding: 1px 6px;
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.15));
  border-radius: 8px;
}
.ws-row-label {
  font-size: 0.75em;
  color: var(--text-color-secondary, #666);
}
</style>
