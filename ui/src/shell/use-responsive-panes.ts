import { computed, onScopeDispose, ref } from "vue";

export type OverlayPane = "nav" | "inspector";

export const INSPECTOR_MIN_WIDTH = 240;
export const INSPECTOR_MAX_WIDTH = 640;

/**
 * Responsive three-pane state: independent collapse for wide viewports,
 * overlay drawers for narrow ones, bounded inspector resizing. The center
 * pane is always mounted; this composable never touches Host state.
 */
export function useResponsivePanes(options: { narrowBreakpoint?: number } = {}) {
  const breakpoint = options.narrowBreakpoint ?? 900;
  const viewportWidth = ref(typeof window === "undefined" ? 1280 : window.innerWidth);

  const onResize = () => {
    viewportWidth.value = window.innerWidth;
  };
  if (typeof window !== "undefined") {
    window.addEventListener("resize", onResize);
  }
  onScopeDispose(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", onResize);
    }
  });

  const narrow = computed(() => viewportWidth.value < breakpoint);
  const leftCollapsed = ref(false);
  const rightCollapsed = ref(false);
  const overlay = ref<OverlayPane | null>(null);
  const inspectorWidth = ref(360);

  function toggleLeft(): void {
    leftCollapsed.value = !leftCollapsed.value;
  }

  function toggleRight(): void {
    rightCollapsed.value = !rightCollapsed.value;
  }

  function openOverlay(which: OverlayPane): void {
    overlay.value = which;
  }

  function closeOverlay(): void {
    overlay.value = null;
  }

  function setInspectorWidth(width: number): void {
    inspectorWidth.value = Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, width));
  }

  function startInspectorResize(event: MouseEvent): void {
    const startX = event.clientX;
    const startWidth = inspectorWidth.value;
    const onMove = (move: MouseEvent) => {
      setInspectorWidth(startWidth + (startX - move.clientX));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    event.preventDefault();
  }

  return {
    narrow,
    leftCollapsed,
    rightCollapsed,
    overlay,
    inspectorWidth,
    toggleLeft,
    toggleRight,
    openOverlay,
    closeOverlay,
    setInspectorWidth,
    startInspectorResize,
  };
}
