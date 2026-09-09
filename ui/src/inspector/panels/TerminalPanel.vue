<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { InspectorTab } from "../inspector-store";

export type TerminalView = {
  terminalId: string;
  capabilities: readonly string[];
  terminateAvailable?: boolean;
};

const props = defineProps<{ tab?: InspectorTab; terminal: TerminalView }>();

const emit = defineEmits<{ terminate: [terminalId: string] }>();

const output = ref<string[]>([]);

// Closing or collapsing the panel releases expensive renderer resources;
// the underlying Host terminal keeps running unless terminate is invoked.
onBeforeUnmount(() => {
  output.value = [];
});

function can(capability: string): boolean {
  return props.terminal.capabilities.includes(capability);
}
</script>

<template>
  <div class="ws-terminal-panel" data-testid="terminal-panel" :data-terminal-id="terminal.terminalId">
    <header class="ws-terminal-header">
      <span>{{ terminal.terminalId }}</span>
      <button
        v-if="terminal.terminateAvailable === true"
        type="button"
        class="ws-terminal-terminate"
        data-testid="terminal-terminate"
        @click="emit('terminate', terminal.terminalId)"
      >Terminate</button>
    </header>
    <pre class="ws-terminal-output" data-testid="terminal-output">{{ output.join("\n") }}</pre>
    <form v-if="can('terminal.send')" class="ws-terminal-input" data-testid="terminal-send-form">
      <input type="text" aria-label="Terminal input" data-testid="terminal-send" />
    </form>
  </div>
</template>

<style scoped>
.ws-terminal-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
}
.ws-terminal-header {
  display: flex;
  justify-content: space-between;
  font-size: 0.85em;
}
.ws-terminal-output {
  min-height: 120px;
  background: var(--fill-color, #1e1e1e0d);
  font-size: 0.8em;
  padding: 6px;
  overflow: auto;
}
.ws-terminal-terminate {
  border: none;
  background: transparent;
  color: var(--color-danger, #c45656);
  cursor: pointer;
}
</style>
