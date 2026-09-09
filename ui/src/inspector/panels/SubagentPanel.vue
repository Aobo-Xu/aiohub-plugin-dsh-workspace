<script setup lang="ts">
import type { InspectorTab } from "../inspector-store";

export type SubagentView = {
  agentId: string;
  name: string;
  parentSessionId: string;
  spawnOrder: number;
  source: string;
  status?: string;
  controls?: readonly { id: string; label: string }[];
};

defineProps<{ tab?: InspectorTab; subagent: SubagentView }>();
</script>

<template>
  <div class="ws-subagent-panel" data-testid="subagent-panel" :data-agent-id="subagent.agentId">
    <h4>{{ subagent.name }}</h4>
    <dl class="ws-subagent-facts">
      <dt>Lineage</dt>
      <dd data-testid="subagent-lineage">{{ subagent.parentSessionId }} → {{ subagent.agentId }}</dd>
      <dt>Order</dt>
      <dd data-testid="subagent-order">#{{ subagent.spawnOrder }}</dd>
      <dt>Source</dt>
      <dd data-testid="subagent-source">{{ subagent.source }}</dd>
      <dt v-if="subagent.status">Status</dt>
      <dd v-if="subagent.status" data-testid="subagent-status">{{ subagent.status }}</dd>
    </dl>
    <div class="ws-subagent-controls">
      <button
        v-for="control in subagent.controls ?? []"
        :key="control.id"
        type="button"
        data-testid="subagent-control"
        :data-control-id="control.id"
      >{{ control.label }}</button>
    </div>
  </div>
</template>

<style scoped>
.ws-subagent-panel {
  padding: 8px;
}
.ws-subagent-facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 8px;
  font-size: 0.85em;
  margin: 0;
}
.ws-subagent-facts dt {
  color: var(--text-color-secondary, #666);
}
.ws-subagent-facts dd {
  margin: 0;
}
</style>
