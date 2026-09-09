<script setup lang="ts">
import { toViewModelSafe } from "../presenters/registry";
import type { ProjectedEvent } from "../state/reducers/session-reducer";

const props = defineProps<{
  turnId: string;
  events: readonly ProjectedEvent[];
}>();

function anchorFor(index: number, event: ProjectedEvent): string {
  // Host-identity anchor: stable across virtualized remounts because the
  // projection order is deterministic for the same accepted event sequence.
  return `${props.turnId}#${index}#${event.kind}`;
}
</script>

<template>
  <ul class="ws-process">
    <li
      v-for="(event, index) in events"
      :key="anchorFor(index, event)"
      class="ws-process-card"
      data-testid="process-card"
      :data-anchor-id="anchorFor(index, event)"
      :data-event-kind="event.kind"
    >
      <template v-for="view in [toViewModelSafe(event)]" :key="view.kind">
        <span class="ws-card-summary">{{ view.summary }}</span>
        <span v-if="view.status" class="ws-card-status" :aria-label="view.status">{{ view.status }}</span>
        <span v-if="view.degraded" class="ws-card-degraded" aria-label="Presenter degraded">degraded</span>
        <span class="ws-card-actions">
          <button
            v-for="action in view.actions ?? []"
            :key="action.id"
            type="button"
            class="ws-card-action"
            :data-action="action.id"
            :data-anchor-id="anchorFor(index, event)"
          >{{ action.label }}</button>
        </span>
      </template>
    </li>
  </ul>
</template>

<style scoped>
.ws-process {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ws-process-card {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 4px 8px;
  border-left: 2px solid var(--border-color, rgba(0, 0, 0, 0.12));
  font-size: 0.9em;
}
.ws-card-summary {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.ws-card-status,
.ws-card-degraded {
  font-size: 0.8em;
  padding: 0 6px;
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.15));
  border-radius: 8px;
}
.ws-card-action {
  border: none;
  background: transparent;
  color: var(--color-primary, #409eff);
  cursor: pointer;
  font-size: 0.85em;
  padding: 0 4px;
}
</style>
