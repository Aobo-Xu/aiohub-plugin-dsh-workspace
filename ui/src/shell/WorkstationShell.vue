<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import CompatibilitySurface from "./CompatibilitySurface.vue";
import RuntimeStrip from "./RuntimeStrip.vue";
import { useResponsivePanes, type OverlayPane } from "./use-responsive-panes";

const props = defineProps<{
  runtimeState: string;
  mutationsAvailable: boolean;
  formalReleaseBlocked?: boolean;
  unavailableReason?: string;
  interactionActive?: boolean;
}>();

const ACTIONABLE_STATES: ReadonlySet<string> = new Set(["ready", "busy"]);
const actionable = computed(() => ACTIONABLE_STATES.has(props.runtimeState));

const {
  narrow,
  leftCollapsed,
  rightCollapsed,
  overlay,
  inspectorWidth,
  toggleLeft,
  toggleRight,
  openOverlay,
  closeOverlay,
  startInspectorResize,
} = useResponsivePanes();

const restoreFocusTo = ref<HTMLElement | null>(null);

function openOverlayWithFocus(which: OverlayPane, trigger?: EventTarget | null): void {
  // Capture the trigger from the dispatching event: jsdom and assistive
  // activation paths do not move document.activeElement on click, so the
  // activeElement fallback alone would restore focus to <body>.
  restoreFocusTo.value =
    (trigger as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
  openOverlay(which);
}

function closeOverlayAndRestore(): void {
  closeOverlay();
  void nextTick(() => {
    restoreFocusTo.value?.focus();
    restoreFocusTo.value = null;
  });
}
</script>

<template>
  <div class="ws-shell">
    <RuntimeStrip
      :runtime-state="runtimeState"
      :mutations-available="mutationsAvailable"
      :formal-release-blocked="formalReleaseBlocked === true"
    />

    <CompatibilitySurface
      v-if="!actionable"
      :runtime-state="runtimeState"
      :reason="unavailableReason"
    />

    <div v-else class="ws-body">
      <div v-if="narrow" class="ws-rail" data-testid="nav-rail">
        <button
          type="button"
          data-testid="rail-nav"
          aria-label="Open navigation"
          @click="openOverlayWithFocus('nav', $event.currentTarget)"
        >&#9776;</button>
        <button
          type="button"
          data-testid="rail-inspector"
          aria-label="Open inspector"
          @click="openOverlayWithFocus('inspector', $event.currentTarget)"
        >&#9775;</button>
      </div>

      <template v-else>
        <aside v-if="!leftCollapsed" class="ws-nav" data-testid="nav-pane">
          <slot name="nav" />
        </aside>
        <button
          type="button"
          class="ws-collapse"
          data-testid="toggle-left"
          :aria-pressed="leftCollapsed"
          aria-label="Toggle navigation pane"
          @click="toggleLeft"
        >&#8249;</button>
      </template>

      <main class="ws-center" data-testid="center-pane">
        <div v-if="interactionActive" class="ws-interaction" data-testid="interaction-region">
          <slot name="interaction" />
        </div>
        <div class="ws-timeline">
          <slot />
        </div>
        <div class="ws-composer" data-testid="composer-region">
          <slot name="composer" />
        </div>
      </main>

      <template v-if="!narrow">
        <button
          type="button"
          class="ws-collapse"
          data-testid="toggle-right"
          :aria-pressed="rightCollapsed"
          aria-label="Toggle inspector pane"
          @click="toggleRight"
        >&#8250;</button>
        <aside
          v-if="!rightCollapsed"
          class="ws-inspector"
          data-testid="inspector-pane"
          :style="{ width: `${inspectorWidth}px` }"
        >
          <div
            class="ws-inspector-resizer"
            data-testid="inspector-resizer"
            role="separator"
            aria-orientation="vertical"
            @mousedown="startInspectorResize"
          ></div>
          <slot name="inspector" />
        </aside>
      </template>

      <div
        v-if="overlay === 'nav'"
        class="ws-overlay"
        data-testid="overlay-nav"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
      >
        <button type="button" data-testid="overlay-close" aria-label="Close" @click="closeOverlayAndRestore">&times;</button>
        <slot name="nav" />
      </div>
      <div
        v-if="overlay === 'inspector'"
        class="ws-overlay ws-overlay-right"
        data-testid="overlay-inspector"
        role="dialog"
        aria-modal="true"
        aria-label="Inspector"
      >
        <button type="button" data-testid="overlay-close" aria-label="Close" @click="closeOverlayAndRestore">&times;</button>
        <slot name="inspector" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.ws-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--bg-color, transparent);
  color: var(--text-color, inherit);
}
.ws-body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}
.ws-rail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 44px;
  padding: 8px 4px;
  border-right: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
}
.ws-nav {
  width: 260px;
  border-right: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
  overflow: auto;
}
.ws-center {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.ws-timeline {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.ws-interaction {
  border-bottom: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
}
.ws-composer {
  border-top: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
}
.ws-inspector {
  position: relative;
  border-left: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
  overflow: auto;
}
.ws-inspector-resizer {
  position: absolute;
  left: -3px;
  top: 0;
  width: 6px;
  height: 100%;
  cursor: col-resize;
}
.ws-collapse {
  align-self: center;
  border: none;
  background: transparent;
  color: var(--text-color-secondary, #666);
  cursor: pointer;
  padding: 4px;
}
.ws-overlay {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 10;
  width: min(320px, 85vw);
  height: 100%;
  background: var(--bg-color, #fff);
  border-right: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
  box-shadow: var(--el-box-shadow-light, 0 2px 12px rgba(0, 0, 0, 0.1));
  overflow: auto;
}
.ws-overlay-right {
  left: auto;
  right: 0;
  border-right: none;
  border-left: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
}
.ws-shell :deep(button:focus-visible),
.ws-shell :deep([tabindex]:focus-visible) {
  outline: 2px solid var(--color-primary, #409eff);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  .ws-shell *,
  .ws-overlay {
    transition: none !important;
    animation: none !important;
  }
}
</style>
