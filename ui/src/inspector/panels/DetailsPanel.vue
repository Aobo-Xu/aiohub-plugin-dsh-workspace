<script setup lang="ts">
import { computed } from "vue";
import type { InspectorTab } from "../inspector-store";
import { maskSecrets } from "../../presenters/registry";

const props = defineProps<{ tab?: InspectorTab; details?: unknown }>();

const bounded = computed(() =>
  JSON.stringify(maskSecrets(props.details ?? { title: props.tab?.title, resourceRef: props.tab?.resourceRef ?? null })),
);
</script>

<template>
  <div class="ws-details-panel" data-testid="details-panel">
    <h4 v-if="tab">{{ tab.title }}</h4>
    <pre class="ws-details-body" data-testid="details-body">{{ bounded }}</pre>
  </div>
</template>

<style scoped>
.ws-details-panel {
  padding: 8px;
}
.ws-details-body {
  font-size: 0.8em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
