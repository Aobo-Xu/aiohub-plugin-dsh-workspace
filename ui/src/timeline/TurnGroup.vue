<script setup lang="ts">
import { computed, ref, watch } from "vue";
import WorkProcess from "./WorkProcess.vue";
import { boundedText, toViewModelSafe, type PresenterProvenance } from "../presenters/registry";
import type { ProjectedEvent, TurnProjection, TurnStatus } from "../state/reducers/session-reducer";

const props = defineProps<{
  turn: TurnProjection;
  provenance?: PresenterProvenance;
  durationLabel?: string;
}>();

const STATUS_LABELS: Readonly<Record<TurnStatus, string>> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

const OPEN_BY_DEFAULT: ReadonlySet<TurnStatus> = new Set(["running", "failed", "interrupted"]);

const expanded = ref(OPEN_BY_DEFAULT.has(props.turn.status));
watch(
  () => props.turn.status,
  (status) => {
    expanded.value = OPEN_BY_DEFAULT.has(status);
  },
);

const userEvents = computed(() => props.turn.events.filter((event) => event.kind === "user/message"));
const finalEvents = computed(() => props.turn.events.filter((event) => event.kind === "assistant/message"));
const processEvents = computed(() =>
  props.turn.events.filter(
    (event) => !event.kind.startsWith("turn/") && event.kind !== "user/message" && event.kind !== "assistant/message",
  ),
);
const failureDetail = computed(() => {
  const terminal = props.turn.events.find(
    (event): event is ProjectedEvent => event.kind === "turn/failed" || event.kind === "turn/interrupted",
  );
  const data = terminal?.data;
  if (typeof data === "object" && data !== null) {
    const reason = (data as Record<string, unknown>).reason ?? (data as Record<string, unknown>).message;
    if (typeof reason === "string") return boundedText(reason);
  }
  return undefined;
});

function summaryOf(events: readonly ProjectedEvent[]): string {
  return events.map((event) => toViewModelSafe(event).summary).join("\n");
}
</script>

<template>
  <section class="ws-turn" data-testid="turn-group" :data-turn-id="turn.turnId" :data-turn-status="turn.status">
    <header class="ws-turn-header">
      <span class="ws-turn-status" data-testid="turn-status" :aria-label="`Turn ${STATUS_LABELS[turn.status]}`">
        {{ STATUS_LABELS[turn.status] }}
      </span>
      <span class="ws-turn-meta" data-testid="turn-event-count">{{ turn.events.length }}</span>
      <span v-if="durationLabel" class="ws-turn-meta" data-testid="turn-duration">{{ durationLabel }}</span>
      <button
        type="button"
        data-testid="process-toggle"
        :aria-expanded="expanded ? 'true' : 'false'"
        aria-label="Toggle work process"
        @click="expanded = !expanded"
      >{{ expanded ? "Hide process" : "Show process" }}</button>
    </header>

    <div
      v-if="userEvents.length > 0"
      class="ws-turn-user"
      data-testid="turn-user-input"
      :data-anchor-id="`${turn.turnId}#user`"
    >
      {{ summaryOf(userEvents) }}
    </div>

    <WorkProcess v-if="expanded" :turn-id="turn.turnId" :events="processEvents" />

    <div
      v-if="finalEvents.length > 0"
      class="ws-turn-final"
      data-testid="turn-final-response"
      :data-anchor-id="`${turn.turnId}#final`"
    >
      {{ summaryOf(finalEvents) }}
    </div>

    <div v-if="provenance" class="ws-turn-provenance" data-testid="turn-provenance">
      {{ provenance.model }} · {{ provenance.source }} · {{ provenance.preset }}
    </div>

    <div v-if="failureDetail" class="ws-turn-failure" data-testid="turn-failure-detail" role="alert">
      {{ failureDetail }}
    </div>
  </section>
</template>

<style scoped>
.ws-turn {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid var(--border-color, rgba(0, 0, 0, 0.08));
}
.ws-turn-header {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 0.85em;
}
.ws-turn-status {
  font-weight: 600;
}
.ws-turn-meta {
  color: var(--text-color-secondary, #666);
}
.ws-turn-header button {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--color-primary, #409eff);
  cursor: pointer;
}
.ws-turn-user,
.ws-turn-final {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ws-turn-provenance {
  font-size: 0.75em;
  color: var(--text-color-secondary, #666);
}
.ws-turn-failure {
  font-size: 0.85em;
  color: var(--color-danger, #c45656);
}
</style>
