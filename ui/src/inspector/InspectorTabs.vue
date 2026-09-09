<script setup lang="ts">
import type { InspectorTab } from "./inspector-store";

defineProps<{
  tabs: readonly InspectorTab[];
  activeTabId?: string;
  creatable: readonly { panelType: string; title: string }[];
  addMenuOpen: boolean;
}>();

defineEmits<{
  select: [tabId: string];
  close: [tabId: string];
  pin: [tabId: string];
  "toggle-add-menu": [];
  create: [panelType: string];
}>();
</script>

<template>
  <div class="ws-inspector-tabs" role="tablist">
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="ws-tab"
      role="tab"
      data-testid="inspector-tab"
      :data-tab-id="tab.id"
      :data-panel-type="tab.panelType"
      :aria-selected="tab.id === activeTabId ? 'true' : 'false'"
      @click="$emit('select', tab.id)"
    >
      <span class="ws-tab-title">{{ tab.title }}</span>
      <button
        type="button"
        class="ws-tab-pin"
        data-testid="tab-pin"
        :aria-pressed="tab.pinned ? 'true' : 'false'"
        aria-label="Pin tab"
        @click.stop="$emit('pin', tab.id)"
      >&#128204;</button>
      <button
        type="button"
        class="ws-tab-close"
        data-testid="tab-close"
        aria-label="Close tab"
        @click.stop="$emit('close', tab.id)"
      >&times;</button>
    </div>
    <button
      type="button"
      class="ws-tab-add"
      data-testid="add-tab"
      aria-label="Add inspector panel"
      aria-haspopup="menu"
      :aria-expanded="addMenuOpen ? 'true' : 'false'"
      @click="$emit('toggle-add-menu')"
    >+</button>
    <ul v-if="addMenuOpen" class="ws-add-menu" data-testid="add-menu" role="menu">
      <li v-for="descriptor in creatable" :key="descriptor.panelType" role="none">
        <button
          type="button"
          role="menuitem"
          :data-testid="`create-${descriptor.panelType}`"
          @click="$emit('create', descriptor.panelType)"
        >{{ descriptor.title }}</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.ws-inspector-tabs {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  padding: 4px;
  border-bottom: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
}
.ws-tab {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 2px 6px;
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85em;
}
.ws-tab[aria-selected="true"] {
  border-color: var(--color-primary, #409eff);
}
.ws-tab-title {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-tab-pin,
.ws-tab-close,
.ws-tab-add {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-color-secondary, #666);
  padding: 0 2px;
}
.ws-add-menu {
  position: absolute;
  top: 100%;
  right: 4px;
  z-index: 20;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--bg-color, #fff);
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.15));
  border-radius: 6px;
  box-shadow: var(--el-box-shadow-light, 0 2px 12px rgba(0, 0, 0, 0.12));
}
.ws-add-menu button {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  padding: 4px 10px;
  cursor: pointer;
  color: var(--text-color, inherit);
}
</style>
