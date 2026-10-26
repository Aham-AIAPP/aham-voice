import { useCallback, useEffect, useRef } from "react";

/**
 * 弹窗 / 抽屉的焦点陷阱（对齐 aham-voice）。
 * active 变 true 时：记录当前焦点元素 → 把焦点移入容器 → Tab/Shift+Tab 在容器内循环；
 * active 变 false 或卸载时把焦点还给触发元素。
 *   const ref = useFocusTrap<HTMLDivElement>(open);
 *   return <div ref={ref} role="dialog" aria-modal="true">…</div>;
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(active: boolean) {
  const containerRef = useRef<T | null>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);

  const getFocusable = useCallback((): HTMLElement[] => {
    const root = containerRef.current;
    if (!root) return [];
    const selector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])',
    ].join(",");
    return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
      (el) =>
        !el.hasAttribute("disabled") &&
        el.getAttribute("aria-hidden") !== "true" &&
        (el.offsetParent !== null || el.getClientRects().length > 0),
    );
  }, []);

  useEffect(() => {
    if (!active) return;

    const root = containerRef.current;
    previousActiveRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (root && !root.contains(document.activeElement)) {
      const focusable = getFocusable();
      (focusable[0] ?? root).focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        root?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (activeEl === first || !root?.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !root?.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const prev = previousActiveRef.current;
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [active, getFocusable]);

  return containerRef;
}
