<script setup lang="ts">
defineProps<{
  sectionId: string;
  title: string;
  collapsed: boolean;
}>();

defineEmits<{ toggle: [] }>();
</script>

<template>
  <div class="ws-nav-section">
    <h3 class="ws-section-header">
      <button
        type="button"
        :data-testid="`section-toggle-${sectionId}`"
        :aria-expanded="collapsed ? 'false' : 'true'"
        :aria-label="`${collapsed ? 'Expand' : 'Collapse'} ${title}`"
        @click="$emit('toggle')"
      >{{ title }}</button>
    </h3>
    <ul v-if="!collapsed" class="ws-section-list">
      <slot />
    </ul>
  </div>
</template>

<style scoped>
.ws-section-header {
  margin: 0;
  font-size: 0.85em;
}
.ws-section-header button {
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: transparent;
  color: var(--text-color-secondary, #666);
  text-align: left;
  cursor: pointer;
}
.ws-section-list {
  margin: 0;
  padding: 0;
}
</style>
