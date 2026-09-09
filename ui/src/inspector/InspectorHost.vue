<script setup lang="ts">
import { computed, ref } from "vue";
import InspectorTabs from "./InspectorTabs.vue";
import DetailsPanel from "./panels/DetailsPanel.vue";
import TasksContextPanel from "./panels/TasksContextPanel.vue";
import FilesPanel from "./panels/FilesPanel.vue";
import DiffReviewPanel from "./panels/DiffReviewPanel.vue";
import TerminalPanel from "./panels/TerminalPanel.vue";
import SubagentPanel from "./panels/SubagentPanel.vue";
import StatisticsPanel from "./panels/StatisticsPanel.vue";
import GoalPanel from "./panels/GoalPanel.vue";
import {
  createInspectorStore,
  type AvailabilityFn,
  type InspectorTab,
  type PanelDescriptor,
} from "./inspector-store";
import { availablePanelTypes } from "./panel-registry";
import { maskSecrets } from "../presenters/registry";

const props = defineProps<{
  sessionId: string;
  descriptors: readonly PanelDescriptor[];
  availability: AvailabilityFn;
  narrow: boolean;
}>();

const store = createInspectorStore({ descriptors: props.descriptors, availability: props.availability });
const addMenuOpen = ref(false);

const tabs = computed(() => store.tabsFor(props.sessionId));
const activeTab = computed(() => tabs.value.find((tab) => tab.id === store.activeTabId(props.sessionId)));
const creatable = computed(() => availablePanelTypes(props.descriptors, props.availability));

function open(panelType: string): void {
  store.openPanel(props.sessionId, { panelType });
  addMenuOpen.value = false;
}

function panelComponent(panelType: string) {
  switch (panelType) {
    case "tasks":
      return TasksContextPanel;
    case "files":
      return FilesPanel;
    case "diff":
      return DiffReviewPanel;
    case "terminal":
      return TerminalPanel;
    case "subagent":
      return SubagentPanel;
    case "statistics":
      return StatisticsPanel;
    case "goal":
      return GoalPanel;
    default:
      return DetailsPanel;
  }
}

function boundedGeneric(tab: InspectorTab): string {
  return JSON.stringify(maskSecrets({ panelType: tab.panelType, resourceRef: tab.resourceRef ?? null }));
}
</script>

<template>
  <aside
    class="ws-inspector"
    :class="narrow ? 'ws-inspector-overlay' : 'ws-inspector-docked'"
    :data-testid="narrow ? 'inspector-overlay' : 'inspector-docked'"
    aria-label="Inspector"
  >
    <div v-if="store.chooserVisible(sessionId)" class="ws-chooser" data-testid="inspector-chooser">
      <p>Open a panel</p>
      <button
        v-for="descriptor in creatable"
        :key="descriptor.panelType"
        type="button"
        :data-testid="`choose-${descriptor.panelType}`"
        @click="open(descriptor.panelType)"
      >{{ descriptor.title }}</button>
    </div>
    <template v-else>
      <InspectorTabs
        :tabs="tabs"
        :active-tab-id="store.activeTabId(sessionId)"
        :creatable="creatable"
        :add-menu-open="addMenuOpen"
        @select="(tabId) => store.openPanel(sessionId, { panelType: tabs.find((t) => t.id === tabId)?.panelType ?? 'details' })"
        @close="(tabId) => store.closeTab(sessionId, tabId)"
        @pin="(tabId) => store.togglePin(sessionId, tabId)"
        @toggle-add-menu="addMenuOpen = !addMenuOpen"
        @create="open"
      />
      <div class="ws-inspector-body">
        <component
          :is="panelComponent(activeTab?.panelType ?? 'details')"
          v-if="activeTab"
          :key="activeTab.id"
          :tab="activeTab"
        />
        <pre v-if="activeTab?.panelType === 'generic'" class="ws-generic" data-testid="generic-panel">{{ boundedGeneric(activeTab) }}</pre>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.ws-inspector {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--bg-color, #fff);
}
.ws-inspector-docked {
  border-left: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
}
.ws-inspector-overlay {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 30;
  width: min(480px, 92vw);
  box-shadow: var(--el-box-shadow-light, 0 2px 16px rgba(0, 0, 0, 0.18));
}
.ws-chooser {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
}
.ws-chooser button {
  padding: 6px 10px;
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  color: var(--text-color, inherit);
}
.ws-inspector-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.ws-generic {
  margin: 8px;
  font-size: 0.8em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
