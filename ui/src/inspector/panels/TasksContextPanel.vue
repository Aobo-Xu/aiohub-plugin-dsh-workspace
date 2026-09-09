<script setup lang="ts">
import type { InspectorTab } from "../inspector-store";

defineProps<{ tab?: InspectorTab; facts?: readonly { id: string; text: string }[] }>();
</script>

<template>
  <div class="ws-tasks-context" data-testid="tasks-context-panel">
    <h4 v-if="tab">{{ tab.title }}</h4>
    <ul>
      <li v-for="fact in facts ?? []" :key="fact.id" :data-fact-id="fact.id">{{ fact.text }}</li>
    </ul>
    <p v-if="(facts ?? []).length === 0" class="ws-empty">No Host context facts reported.</p>
  </div>
</template>

<style scoped>
.ws-tasks-context {
  padding: 8px;
}
.ws-empty {
  color: var(--text-color-secondary, #666);
  font-size: 0.85em;
}
</style>
