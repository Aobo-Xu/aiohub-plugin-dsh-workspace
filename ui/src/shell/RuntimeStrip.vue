<script setup lang="ts">
defineProps<{
  runtimeState: string;
  mutationsAvailable: boolean;
  formalReleaseBlocked?: boolean;
}>();
</script>

<template>
  <div class="ws-runtime-strip" data-testid="runtime-strip">
    <span class="ws-runtime-state" data-testid="runtime-state">{{ runtimeState }}</span>
    <span
      v-if="!mutationsAvailable"
      class="ws-badge ws-badge-warning"
      data-testid="readonly-badge"
      data-tone="warning"
    >read-only</span>
    <span
      v-if="formalReleaseBlocked"
      class="ws-badge ws-badge-blocked"
      data-testid="release-blocked-badge"
      data-tone="blocked"
    >release blocked</span>
  </div>
</template>

<style scoped>
.ws-runtime-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-color-secondary, #666);
  border-bottom: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
}
.ws-badge {
  padding: 1px 8px;
  border-radius: 4px;
  font-size: 11px;
}
.ws-badge-warning {
  background: var(--el-color-warning-light-8, rgba(230, 162, 60, 0.15));
  color: var(--el-color-warning, #b88230);
}
.ws-badge-blocked {
  background: var(--el-color-danger-light-8, rgba(245, 108, 108, 0.15));
  color: var(--el-color-danger, #f56c6c);
}
</style>
