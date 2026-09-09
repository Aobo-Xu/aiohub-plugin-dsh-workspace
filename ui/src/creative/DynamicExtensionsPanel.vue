<script setup lang="ts">
import DynamicExtensionCard, { type DynamicExtensionView } from "./DynamicExtensionCard.vue";

defineProps<{ extensions: readonly DynamicExtensionView[] }>();

const emit = defineEmits<{ action: [payload: { packageId: string; action: string }] }>();
</script>

<template>
  <section class="ws-ext-panel" data-testid="dynamic-extensions-panel" aria-label="Dynamic extensions">
    <template v-for="extension in extensions" :key="extension.packageId">
      <!-- Browser-half packages fail closed: the boundary is reported at once,
           nothing is mounted and no DSH page is awaited. An accepted isolated
           client bridge would be a separate future change. -->
      <p
        v-if="extension.execution === 'browser-half'"
        class="ws-ext-unsupported"
        data-testid="browser-half-unsupported"
        role="alert"
      >
        {{ extension.packageId }}: browser-half execution is unsupported in this workstation
        (no accepted isolated client bridge). The component is not mounted or executed.
      </p>
      <DynamicExtensionCard v-else :extension="extension" @action="emit('action', $event)" />
    </template>
    <p v-if="extensions.length === 0" class="ws-ext-empty" role="status">No dynamic extensions reported by the Host.</p>
  </section>
</template>

<style scoped>
.ws-ext-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ws-ext-unsupported {
  margin: 0;
  padding: 8px;
  border: 1px dashed var(--border-color, rgba(0, 0, 0, 0.2));
  border-radius: 8px;
  font-size: 0.85em;
  color: var(--color-warning, #b88230);
}
.ws-ext-empty {
  color: var(--text-color-secondary, #666);
  font-size: 0.85em;
}
</style>
