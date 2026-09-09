<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{
  open: boolean;
  sessionId: string;
  eligible: boolean;
  blockedReason?: string;
  otherSessionCreative?: boolean;
  hostDefaultPresetId?: string;
  transition?: { fromGeneration: string; toGeneration: string; isolated: boolean };
}>();

const emit = defineEmits<{
  "enter-creative": [payload: { sessionId: string }];
  close: [];
}>();

const acknowledged = ref(false);
const sent = ref(false);
watch(
  () => props.sessionId,
  () => {
    // Consent is strictly per session; switching session resets it and new
    // sessions always start from the Host-provided default.
    acknowledged.value = false;
    sent.value = false;
  },
);

function confirm(): void {
  if (!props.eligible || !acknowledged.value || sent.value) return;
  sent.value = true;
  emit("enter-creative", { sessionId: props.sessionId });
}
</script>

<template>
  <div v-if="open" class="ws-creative-dialog" role="dialog" aria-modal="true" aria-label="Creative mode">
    <template v-if="eligible">
      <p data-testid="creative-risk-text">
        Creative mode enables Host self-modification and dynamic package execution inside an
        isolated generation. Review the risks before continuing.
      </p>
      <p v-if="otherSessionCreative" data-testid="creative-no-inheritance" role="status">
        Consent is never inherited: new sessions start from the Host default
        ({{ hostDefaultPresetId ?? "Host-provided default" }}).
      </p>
      <p v-if="transition" data-testid="creative-transition" role="status">
        Host-reported transition: generation {{ transition.fromGeneration }} →
        {{ transition.toGeneration }} ({{ transition.isolated ? "isolated" : "shared" }}).
      </p>
      <label class="ws-creative-ack">
        <input v-model="acknowledged" type="checkbox" data-testid="creative-acknowledge" />
        I understand the self-modification and dynamic-package risks for this session.
      </label>
      <div class="ws-creative-actions">
        <button type="button" data-testid="creative-confirm" :disabled="!acknowledged || sent" @click="confirm()">
          Enter creative mode
        </button>
        <button type="button" data-testid="creative-cancel" @click="emit('close')">Cancel</button>
      </div>
    </template>
    <template v-else>
      <p data-testid="creative-blocked" role="alert">Creative mode is blocked: {{ blockedReason ?? "Host reported ineligibility" }}.</p>
      <p data-testid="creative-other-sessions-note" role="status">
        Other sessions are unaffected and keep running.
      </p>
      <button type="button" data-testid="creative-close" @click="emit('close')">Close</button>
    </template>
  </div>
</template>

<style scoped>
.ws-creative-dialog {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.15));
  border-radius: 8px;
  background: var(--bg-color, #fff);
}
.ws-creative-ack {
  display: flex;
  gap: 6px;
  font-size: 0.9em;
}
.ws-creative-actions {
  display: flex;
  gap: 8px;
}
</style>
