<script setup lang="ts">
export type PresetEntry = {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  creative?: boolean;
  /** Optional Host-provided semantic presentation hint; never a branch key. */
  semanticHint?: string;
};

const props = defineProps<{
  roster: readonly PresetEntry[];
  activePresetId?: string;
}>();

const emit = defineEmits<{ select: [presetId: string] }>();

function onSelect(entry: PresetEntry): void {
  if (!entry.available || entry.id === props.activePresetId) return;
  emit("select", entry.id);
}
</script>

<template>
  <div class="ws-preset-selector" data-testid="preset-selector" role="group" aria-label="Session preset">
    <div
      v-for="entry in roster"
      :key="entry.id"
      class="ws-preset-entry"
      data-testid="preset-entry"
      :data-preset-id="entry.id"
    >
      <span data-testid="preset-label">{{ entry.label }}</span>
      <span v-if="entry.id === activePresetId" class="ws-preset-active" aria-label="active">✓</span>
      <button
        type="button"
        data-testid="preset-select"
        :disabled="!entry.available || entry.id === activePresetId"
        :title="entry.available ? entry.semanticHint : entry.reason"
        @click="onSelect(entry)"
      >Select</button>
      <p v-if="!entry.available && entry.reason" class="ws-preset-reason" data-testid="preset-reason" role="status">
        {{ entry.reason }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.ws-preset-selector {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ws-preset-entry {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 4px 8px;
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
  border-radius: 6px;
  font-size: 0.9em;
}
.ws-preset-active {
  color: var(--color-success, #529b2e);
}
.ws-preset-reason {
  flex-basis: 100%;
  margin: 0;
  font-size: 0.85em;
  color: var(--text-color-secondary, #666);
}
</style>
