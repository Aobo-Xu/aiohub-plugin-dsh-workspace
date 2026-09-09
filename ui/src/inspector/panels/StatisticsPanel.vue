<script setup lang="ts">
import type { InspectorTab } from "../inspector-store";

export type SessionStatistics = {
  authoritative: boolean;
  tokens?: { input?: number; output?: number };
  cacheHits?: number;
  turns?: number;
  throughput?: number;
};

defineProps<{ tab?: InspectorTab; statistics: SessionStatistics }>();
</script>

<template>
  <div class="ws-statistics-panel" data-testid="statistics-panel">
    <template v-if="statistics.authoritative">
      <dl class="ws-stats">
        <template v-if="statistics.tokens">
          <dt>Input tokens</dt>
          <dd data-testid="stat-tokens-input">{{ statistics.tokens.input ?? 0 }}</dd>
          <dt>Output tokens</dt>
          <dd data-testid="stat-tokens-output">{{ statistics.tokens.output ?? 0 }}</dd>
        </template>
        <template v-if="statistics.cacheHits !== undefined">
          <dt>Cache hits</dt>
          <dd data-testid="stat-cache-hits">{{ statistics.cacheHits }}</dd>
        </template>
        <template v-if="statistics.turns !== undefined">
          <dt>Turns</dt>
          <dd data-testid="stat-turns">{{ statistics.turns }}</dd>
        </template>
      </dl>
    </template>
    <p v-else data-testid="stat-unavailable" role="status">
      Session statistics are not reported by the Host. Estimates are never shown as exact values.
    </p>
  </div>
</template>

<style scoped>
.ws-statistics-panel {
  padding: 8px;
}
.ws-stats {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 8px;
  font-size: 0.85em;
  margin: 0;
}
.ws-stats dt {
  color: var(--text-color-secondary, #666);
}
.ws-stats dd {
  margin: 0;
}
</style>
