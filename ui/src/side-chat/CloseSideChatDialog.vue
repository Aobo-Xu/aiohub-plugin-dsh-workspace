<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{
  open: boolean;
  scope: "one" | "others" | "all";
  chatTitle?: string;
}>();

const emit = defineEmits<{
  confirm: [payload: { scope: "one" | "others" | "all"; suppressWarning: boolean }];
  cancel: [];
}>();

const suppress = ref(false);

const scopeLabel = { one: "this side chat", others: "the other side chats", all: "all side chats" } as const;

function confirm(): void {
  emit("confirm", { scope: props.scope, suppressWarning: suppress.value });
}
</script>

<template>
  <div v-if="open" class="ws-close-dialog" role="alertdialog" aria-modal="true" aria-label="Close side chat">
    <p data-testid="close-warning">
      {{ scopeLabel[scope] }}{{ chatTitle ? ` (“${chatTitle}”)` : "" }} will be deleted and cannot be recovered.
      Messages, capsules and titles exist only in memory.
    </p>
    <label class="ws-suppress">
      <input v-model="suppress" type="checkbox" data-testid="close-suppress" />
      Do not ask again (UI-only preference)
    </label>
    <div class="ws-close-actions">
      <button type="button" data-testid="close-cancel" @click="emit('cancel')">Cancel</button>
      <button type="button" data-testid="close-confirm" @click="confirm()">Close Side Chat</button>
    </div>
  </div>
</template>

<style scoped>
.ws-close-dialog {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.15));
  border-radius: 8px;
  background: var(--bg-color, #fff);
}
.ws-suppress {
  display: flex;
  gap: 6px;
  font-size: 0.85em;
}
.ws-close-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
