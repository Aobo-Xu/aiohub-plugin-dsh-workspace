const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function restoreFocus(element?: HTMLElement | null): void {
  element?.focus();
}

/**
 * Minimal focus trap for dialogs, drawers and overlay panels: activates onto
 * the first focusable element, cycles Tab within the container and cleans up
 * its listener on deactivate. Callers restore the original trigger via
 * restoreFocus after deactivation.
 */
export function createFocusTrap(container: HTMLElement) {
  let cleanup: (() => void) | undefined;

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (item) => !item.hasAttribute("disabled"),
    );
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey
      ? currentIndex <= 0
        ? items.length - 1
        : currentIndex - 1
      : currentIndex === items.length - 1
        ? 0
        : currentIndex + 1;
    items[next]?.focus();
    event.preventDefault();
  }

  return {
    activate(): void {
      const first = container.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
      container.addEventListener("keydown", onKeydown);
      cleanup = () => container.removeEventListener("keydown", onKeydown);
    },
    deactivate(): void {
      cleanup?.();
      cleanup = undefined;
    },
  };
}
