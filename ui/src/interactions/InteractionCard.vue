<script setup lang="ts">
import { computed, ref, watch } from "vue";

export type InteractionView = {
  correlationId: string;
  kind: "approval" | "question";
  scope?: string;
  risk?: string;
  promptText?: string;
  operations: readonly { id: string; summary: string }[];
  choices: readonly string[];
  state: string;
  resolution?: string;
};

const props = defineProps<{ interaction: InteractionView }>();

const emit = defineEmits<{
  respond: [payload: { correlationId: string; choice: string }];
}>();

const inFlight = ref(false);
watch(
  () => props.interaction.state,
  () => {
    inFlight.value = false;
  },
);

const terminal = computed(() => props.interaction.state !== "pending");

function respond(choice: string): void {
  if (inFlight.value || terminal.value) return;
  inFlight.value = true;
  emit("respond", { correlationId: props.interaction.correlationId, choice });
}
</script>

<template>
  <article
    class="ws-interaction"
    data-testid="interaction-card"
    :data-correlation-id="interaction.correlationId"
    :aria-label="`${interaction.kind} ${interaction.state}`"
  >
    <header class="ws-interaction-header">
      <span class="ws-interaction-kind">{{ interaction.kind }}</span>
      <span v-if="interaction.scope" data-testid="interaction-scope">scope: {{ interaction.scope }}</span>
      <span v-if="interaction.risk" data-testid="interaction-risk">risk: {{ interaction.risk }}</span>
    </header>
    <p v-if="interaction.promptText" class="ws-interaction-prompt">{{ interaction.promptText }}</p>
    <ul v-if="interaction.operations.length > 0" class="ws-interaction-ops">
      <li v-for="operation in interaction.operations" :key="operation.id" :data-operation-id="operation.id">
        {{ operation.summary }}
      </li>
    </ul>
    <p v-if="terminal" class="ws-interaction-resolution" data-testid="interaction-resolution" role="status">
      {{ interaction.resolution ?? interaction.state }}
    </p>
    <div class="ws-interaction-choices">
      <button
        v-for="choice in interaction.choices"
        :key="choice"
        type="button"
        data-testid="interaction-choice"
        :disabled="terminal || inFlight"
        @click="respond(choice)"
      >{{ choice }}</button>
    </div>
  </article>
</template>

<style scoped>
.ws-interaction {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
}
.ws-interaction-header {
  display: flex;
  gap: 8px;
  font-size: 0.8em;
  color: var(--text-color-secondary, #666);
}
.ws-interaction-kind {
  font-weight: 600;
  text-transform: capitalize;
}
.ws-interaction-ops {
  margin: 0;
  padding-left: 18px;
  font-size: 0.9em;
}
.ws-interaction-choices {
  display: flex;
  gap: 6px;
}
</style>
