import { ref } from "vue";

export type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

/**
 * Pure tail-follow state: follow streaming content only while the viewport is
 * near the bottom; otherwise keep the reading position stable and count new
 * content for the jump-to-latest affordance.
 */
export function useTailFollow(options: { threshold?: number } = {}) {
  const threshold = options.threshold ?? 80;
  const following = ref(true);
  const pendingCount = ref(0);

  function updateFromMetrics(metrics: ScrollMetrics): void {
    const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
    following.value = distance <= threshold;
    if (following.value) {
      pendingCount.value = 0;
    }
  }

  function noteContentGrown(): void {
    if (!following.value) {
      pendingCount.value += 1;
    }
  }

  function consumeJumpToLatest(): void {
    following.value = true;
    pendingCount.value = 0;
  }

  return { following, pendingCount, updateFromMetrics, noteContentGrown, consumeJumpToLatest };
}
