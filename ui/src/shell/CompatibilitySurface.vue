<script setup lang="ts">
defineProps<{
  runtimeState: string;
  reason?: string;
}>();
</script>

<template>
  <div class="ws-compat" data-testid="compat-surface" :data-state="runtimeState" role="status">
    <p class="ws-compat-state" data-testid="compat-state">{{ runtimeState }}</p>
    <p v-if="reason" class="ws-compat-reason" data-testid="compat-reason">{{ reason }}</p>
  </div>
</template>

<style scoped>
.ws-compat {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--text-color-secondary, #666);
}
.ws-compat-state {
  font-size: 14px;
  font-weight: 600;
}
.ws-compat-reason {
  font-size: 12px;
  max-width: 480px;
  text-align: center;
}
</style>
