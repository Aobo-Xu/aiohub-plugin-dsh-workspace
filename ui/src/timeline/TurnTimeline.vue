<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import TurnGroup from "./TurnGroup.vue";
import { useTailFollow } from "./use-tail-follow";
import { provenanceFrom, type PresenterProvenance } from "../presenters/registry";
import type { SessionProjection, TurnProjection } from "../state/reducers/session-reducer";

const props = defineProps<{
  projection: SessionProjection;
  /** Current composer selection; never used to relabel historical Turns. */
  currentSelection?: { model?: string; source?: string };
}>();

const follow = useTailFollow();
const scrollElement = ref<HTMLElement | null>(null);

function onScroll(event: Event): void {
  const target = event.target as HTMLElement | null;
  if (target === null) return;
  follow.updateFromMetrics({
    scrollHeight: target.scrollHeight,
    scrollTop: target.scrollTop,
    clientHeight: target.clientHeight,
  });
}

function scrollToBottom(): void {
  const element = scrollElement.value;
  if (element !== null) {
    element.scrollTop = element.scrollHeight;
  }
}

watch(
  () => props.projection,
  () => {
    if (follow.following.value) {
      void nextTick(scrollToBottom);
    } else {
      // Synchronous so the affordance renders in the same update flush.
      follow.noteContentGrown();
    }
  },
);

function onJumpToLatest(): void {
  follow.consumeJumpToLatest();
  void nextTick(scrollToBottom);
}

function durationLabelFor(turn: TurnProjection): string | undefined {
  const stamps: number[] = [];
  for (const event of turn.events) {
    const data = event.data;
    if (typeof data === "object" && data !== null) {
      const at = (data as Record<string, unknown>).at;
      if (typeof at === "number" && Number.isFinite(at)) stamps.push(at);
    }
  }
  if (stamps.length < 2) return undefined;
  const elapsedMs = Math.max(...stamps) - Math.min(...stamps);
  return `${Math.round(elapsedMs / 1000)}s`;
}

function provenanceFor(turn: TurnProjection): PresenterProvenance | undefined {
  for (let index = turn.events.length - 1; index >= 0; index -= 1) {
    const event = turn.events[index];
    if (event.kind !== "assistant/message") continue;
    const data = event.data;
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return provenanceFrom(data as Record<string, unknown>);
    }
  }
  return undefined;
}
</script>

<template>
  <div class="ws-timeline-root">
    <div
      ref="scrollElement"
      class="ws-timeline-scroll"
      data-testid="timeline-scroll"
      @scroll="onScroll"
    >
      <TurnGroup
        v-for="turn in props.projection.turns"
        :key="turn.turnId"
        :turn="turn"
        :provenance="provenanceFor(turn)"
        :duration-label="durationLabelFor(turn)"
      />
    </div>
    <button
      v-if="follow.pendingCount.value > 0"
      type="button"
      class="ws-new-content"
      data-testid="new-content"
      @click="onJumpToLatest"
    >
      New content ({{ follow.pendingCount.value }})
    </button>
  </div>
</template>

<style scoped>
.ws-timeline-root {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}
.ws-timeline-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.ws-new-content {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.15));
  border-radius: 14px;
  background: var(--bg-color, #fff);
  color: var(--color-primary, #409eff);
  padding: 4px 12px;
  cursor: pointer;
  box-shadow: var(--el-box-shadow-light, 0 2px 8px rgba(0, 0, 0, 0.12));
}
</style>
