<script setup lang="ts">
import { computed } from "vue";
import { RichCodeEditor } from "aiohub-ui";
import type { InspectorTab } from "../inspector-store";

export type DiffSnapshot = {
  diffId: string;
  path: string;
  state: "staged" | "unstaged" | "untracked" | "proposed" | "applied" | string;
  revision?: string;
  hunks?: readonly { header: string; lines: readonly string[] }[];
  limitation?: { code: string; message: string };
};

const props = defineProps<{ tab?: InspectorTab; snapshot: DiffSnapshot; newerRevision?: string }>();

const emit = defineEmits<{ "move-to-revision": [revision: string] }>();

const diffText = computed(() =>
  (props.snapshot.hunks ?? []).map((hunk) => `${hunk.header}\n${hunk.lines.join("\n")}`).join("\n"),
);
</script>

<template>
  <div class="ws-diff-panel" data-testid="diff-panel">
    <header class="ws-diff-header">
      <span class="ws-diff-path">{{ snapshot.path }}</span>
      <span data-testid="diff-state">{{ snapshot.state }}</span>
      <span v-if="snapshot.revision" data-testid="diff-revision">{{ snapshot.revision }}</span>
    </header>
    <p v-if="newerRevision" class="ws-diff-newer" data-testid="diff-newer-available" role="status">
      Newer changes available ({{ newerRevision }}).
      <button type="button" data-testid="diff-move-newer" @click="emit('move-to-revision', String(newerRevision))">
        Move to newer snapshot
      </button>
    </p>
    <p v-if="snapshot.limitation" class="ws-diff-limitation" data-testid="diff-limitation" role="status">
      {{ snapshot.limitation.message }} ({{ snapshot.limitation.code }})
    </p>
    <div v-else data-testid="diff-content" class="ws-diff-content">
      <RichCodeEditor :model-value="diffText" language="diff" read-only />
    </div>
  </div>
</template>

<style scoped>
.ws-diff-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
}
.ws-diff-header {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 0.85em;
}
.ws-diff-path {
  font-weight: 600;
}
.ws-diff-newer {
  font-size: 0.8em;
  color: var(--color-warning, #b88230);
}
.ws-diff-limitation {
  font-size: 0.85em;
  color: var(--text-color-secondary, #666);
}
.ws-diff-content {
  min-height: 0;
}
</style>
