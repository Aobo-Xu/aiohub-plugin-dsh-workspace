<script setup lang="ts">
import { computed, ref } from "vue";
import type { AttachmentLimits, SubmitAction } from "./command-gate";

const props = defineProps<{
  sessionId: string;
  canSubmit: boolean;
  busy: boolean;
  queueAvailable: boolean;
  steerAvailable: boolean;
  busyPreference?: "queue" | "steer";
  attachmentLimits?: AttachmentLimits;
  observer?: boolean;
  controllerLabel?: string;
  transferAvailable?: boolean;
}>();

const emit = defineEmits<{
  submit: [payload: { text: string; action: SubmitAction; sessionId: string }];
  steer: [payload: { text: string; sessionId: string }];
  "request-transfer": [sessionId: string];
}>();

const text = ref("");
const emptyHint = ref(false);

const defaultAction = computed<SubmitAction | undefined>(() => {
  if (!props.busy) return "submit";
  const preference = props.busyPreference;
  if (preference === "steer" && props.steerAvailable) return "steer";
  if (preference === "queue" && props.queueAvailable) return "queue";
  if (props.queueAvailable) return "queue";
  if (props.steerAvailable) return "steer";
  return undefined;
});

const sendLabel = computed(() => {
  if (!props.busy) return "Send";
  return defaultAction.value === "steer" ? "Steer" : defaultAction.value === "queue" ? "Queue" : "Send";
});

const sendDisabled = computed(
  () => !props.canSubmit || defaultAction.value === undefined || props.observer === true,
);

function send(action?: SubmitAction): void {
  const chosen = action ?? defaultAction.value;
  if (chosen === undefined || sendDisabled.value) return;
  if (text.value.trim().length === 0) {
    emptyHint.value = true;
    return;
  }
  emptyHint.value = false;
  if (chosen === "steer" && action === "steer") {
    emit("steer", { text: text.value, sessionId: props.sessionId });
  } else {
    emit("submit", { text: text.value, action: chosen, sessionId: props.sessionId });
  }
}
</script>

<template>
  <form class="ws-composer" data-testid="composer-form" @submit.prevent="send()">
    <textarea
      v-model="text"
      class="ws-composer-input"
      data-testid="composer-input"
      :aria-label="`Prompt for session ${sessionId}`"
      rows="2"
      @input="emptyHint = false"
    ></textarea>
    <div class="ws-composer-actions">
      <button
        type="button"
        data-testid="composer-send"
        :disabled="sendDisabled"
        :aria-disabled="sendDisabled ? 'true' : undefined"
        @click="send()"
      >{{ sendLabel }}</button>
      <button
        v-if="busy && steerAvailable"
        type="button"
        data-testid="composer-steer"
        :disabled="!canSubmit"
        title="Steer the running Turn without queueing a new one"
        @click="send('steer')"
      >Steer</button>
      <button
        v-if="observer === true && transferAvailable === true"
        type="button"
        data-testid="composer-request-transfer"
        @click="emit('request-transfer', sessionId)"
      >Request control</button>
    </div>
    <p v-if="emptyHint" class="ws-hint" data-testid="composer-empty-hint" role="alert">
      Add non-blank text or an admitted attachment before sending.
    </p>
    <p v-if="observer === true" class="ws-hint" data-testid="composer-observer-note" role="status">
      Read-only: {{ controllerLabel ?? "another client" }} holds the controller lease.
    </p>
    <p
      v-if="attachmentLimits?.supportAdvertised === true"
      class="ws-hint"
      data-testid="composer-attachment-limits"
    >
      Attachments: max {{ attachmentLimits.maxCount }}, {{ attachmentLimits.maxBytes }} bytes each,
      types {{ attachmentLimits.mediaTypes.join(", ") }}.
    </p>
  </form>
</template>

<style scoped>
.ws-composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
}
.ws-composer-input {
  width: 100%;
  resize: vertical;
}
.ws-composer-actions {
  display: flex;
  gap: 6px;
}
.ws-hint {
  margin: 0;
  font-size: 0.8em;
  color: var(--text-color-secondary, #666);
}
</style>
