<script setup lang="ts">
export type AttentionItem = {
  correlationId: string;
  kind: "approval" | "question";
  workspaceId: string;
  workspaceName?: string;
  sessionId: string;
};

defineProps<{ items: readonly AttentionItem[] }>();

const emit = defineEmits<{
  navigate: [target: { workspaceId: string; sessionId: string; interactionId: string }];
}>();

function onOpen(item: AttentionItem): void {
  emit("navigate", {
    workspaceId: item.workspaceId,
    sessionId: item.sessionId,
    interactionId: item.correlationId,
  });
}
</script>

<template>
  <ul class="ws-attention" data-testid="need-attention" aria-label="Need attention">
    <li
      v-for="item in items"
      :key="item.correlationId"
      class="ws-attention-entry"
      data-testid="attention-entry"
      :data-correlation-id="item.correlationId"
      role="button"
      tabindex="0"
      @click="onOpen(item)"
      @keydown.enter="onOpen(item)"
    >
      <span class="ws-attention-kind">{{ item.kind }}</span>
      <span class="ws-attention-workspace">{{ item.workspaceName ?? item.workspaceId }}</span>
      <span class="ws-attention-session">{{ item.sessionId }}</span>
    </li>
    <li v-if="items.length === 0" class="ws-attention-empty">Nothing needs attention.</li>
  </ul>
</template>

<style scoped>
.ws-attention {
  margin: 0;
  padding: 0;
  list-style: none;
}
.ws-attention-entry {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 0.85em;
}
.ws-attention-kind {
  text-transform: capitalize;
  font-weight: 600;
}
.ws-attention-session {
  color: var(--text-color-secondary, #666);
}
.ws-attention-empty {
  padding: 4px 8px;
  color: var(--text-color-secondary, #666);
  font-size: 0.85em;
}
</style>
