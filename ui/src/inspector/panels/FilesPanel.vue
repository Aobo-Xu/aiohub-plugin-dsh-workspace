<script setup lang="ts">
import { computed } from "vue";
import type { InspectorTab } from "../inspector-store";

export type FileView = {
  path: string;
  revision?: string;
  content?: string;
  truncated?: boolean;
  byteLength?: number;
  sensitiveRanges?: readonly { start: number; end: number }[];
  editorAvailable?: boolean;
};

const props = defineProps<{ tab?: InspectorTab; file: FileView }>();

const emit = defineEmits<{
  copy: [text: string];
  "open-in-editor": [path: string];
  "load-more": [path: string];
}>();

/** Host-identified sensitive ranges are masked before any display or copy. */
const maskedContent = computed(() => {
  const content = props.file.content;
  if (content === undefined) return undefined;
  const ranges = [...(props.file.sensitiveRanges ?? [])].sort((a, b) => a.start - b.start);
  if (ranges.length === 0) return content;
  let masked = "";
  let cursor = 0;
  for (const range of ranges) {
    masked += content.slice(cursor, Math.max(cursor, range.start));
    masked += "[masked]";
    cursor = Math.max(cursor, range.end);
  }
  masked += content.slice(cursor);
  return masked;
});
</script>

<template>
  <div class="ws-files-panel" data-testid="files-panel">
    <header class="ws-file-header">
      <span data-testid="file-path">{{ file.path }}</span>
      <span v-if="file.revision" data-testid="file-revision">{{ file.revision }}</span>
      <span v-if="file.byteLength !== undefined" data-testid="file-size">{{ file.byteLength }} bytes</span>
    </header>
    <p v-if="(file.sensitiveRanges ?? []).length > 0" class="ws-sensitive" data-testid="file-sensitive-warning" role="alert">
      Host-identified sensitive ranges are masked.
    </p>
    <pre v-if="maskedContent !== undefined" class="ws-file-preview" data-testid="file-preview">{{ maskedContent }}</pre>
    <div v-else class="ws-file-meta" data-testid="file-preview">
      Content not loaded{{ file.byteLength !== undefined ? ` (${file.byteLength} bytes)` : "" }}.
    </div>
    <footer class="ws-file-actions">
      <button type="button" data-testid="file-copy" @click="emit('copy', maskedContent ?? '')">Copy</button>
      <button
        v-if="file.editorAvailable === true"
        type="button"
        data-testid="file-open-editor"
        @click="emit('open-in-editor', file.path)"
      >Open in editor</button>
      <button
        v-if="file.truncated === true || maskedContent === undefined"
        type="button"
        data-testid="file-load-more"
        @click="emit('load-more', file.path)"
      >Load bounded content</button>
    </footer>
  </div>
</template>

<style scoped>
.ws-files-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
}
.ws-file-header {
  display: flex;
  gap: 8px;
  font-size: 0.85em;
}
.ws-sensitive {
  font-size: 0.8em;
  color: var(--color-warning, #b88230);
}
.ws-file-preview {
  font-size: 0.8em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow: auto;
}
.ws-file-actions {
  display: flex;
  gap: 6px;
}
</style>
