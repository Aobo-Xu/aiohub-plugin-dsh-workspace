<script setup lang="ts">
export type DynamicExtensionView = {
  packageId: string;
  generation: string;
  status: string;
  source: string;
  /** Host-advertised actions only; the renderer never adds replay/recreate. */
  actions: readonly string[];
  execution?: "host-half" | "browser-half";
  generatedSourcePath?: string;
  reportedToolIdentity?: string;
};

const props = defineProps<{ extension: DynamicExtensionView }>();

const emit = defineEmits<{ action: [payload: { packageId: string; action: string }] }>();

const INACTIVE_STATES: ReadonlySet<string> = new Set(["retired", "removed", "stopped", "failed"]);

function isActive(): boolean {
  return !INACTIVE_STATES.has(props.extension.status);
}
</script>

<template>
  <article class="ws-ext-card" data-testid="extension-card" :data-package-id="extension.packageId">
    <header class="ws-ext-header">
      <span data-testid="ext-id">{{ extension.packageId }}</span>
      <span data-testid="ext-generation">gen: {{ extension.generation }}</span>
      <span data-testid="ext-status">{{ extension.status }}</span>
      <span data-testid="ext-source">source: {{ extension.source }}</span>
    </header>
    <p v-if="!isActive()" class="ws-ext-inactive" data-testid="ext-inactive" role="status">
      Inactive — recreating this package requires a new explicit Turn or approval; it is never replayed automatically.
    </p>
    <p v-if="extension.generatedSourcePath" class="ws-ext-artifact" data-testid="ext-artifact" role="status">
      Generated source is a workspace/staging artifact only: {{ extension.generatedSourcePath }}
    </p>
    <p v-if="extension.reportedToolIdentity" class="ws-ext-tool" data-testid="ext-tool-identity" role="note">
      Reported tool identity (diagnostic context only, never dispatched): {{ extension.reportedToolIdentity }}
    </p>
    <div class="ws-ext-actions">
      <button
        v-for="action in extension.actions"
        :key="action"
        type="button"
        data-testid="ext-action"
        :data-action="action"
        @click="emit('action', { packageId: extension.packageId, action })"
      >{{ action }}</button>
    </div>
  </article>
</template>

<style scoped>
.ws-ext-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
  font-size: 0.9em;
}
.ws-ext-header {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.ws-ext-inactive,
.ws-ext-artifact,
.ws-ext-tool {
  margin: 0;
  font-size: 0.85em;
  color: var(--text-color-secondary, #666);
}
.ws-ext-actions {
  display: flex;
  gap: 6px;
}
</style>
