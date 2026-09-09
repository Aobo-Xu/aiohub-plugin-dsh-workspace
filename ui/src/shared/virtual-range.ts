export type VirtualRangeInput = {
  total: number;
  itemHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan?: number;
};

export type VirtualRange = {
  start: number;
  end: number;
  offsetY: number;
};

/**
 * Bounded window for virtualized long histories: only the visible range plus
 * overscan renders, keeping stable source anchors and Turn state intact while
 * older data pages in on demand.
 */
export function computeVisibleRange(input: VirtualRangeInput): VirtualRange {
  const overscan = input.overscan ?? 0;
  if (input.total <= 0) {
    return { start: 0, end: 0, offsetY: 0 };
  }
  const visible = Math.ceil(input.viewportHeight / input.itemHeight);
  const firstVisible = Math.floor(input.scrollTop / input.itemHeight);
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(input.total, firstVisible + visible + overscan);
  return { start, end, offsetY: start * input.itemHeight };
}
