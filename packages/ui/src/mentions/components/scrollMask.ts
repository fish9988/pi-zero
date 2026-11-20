import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

const SCROLL_MASK_EDGE_SIZE_PX = 24;
const SCROLL_MASK_THRESHOLD_PX = 1;

export interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export interface ScrollMaskState {
  showBottom: boolean;
  showTop: boolean;
}

export const EMPTY_SCROLL_MASK_STATE: ScrollMaskState = {
  showBottom: false,
  showTop: false,
};

export function resolveVerticalScrollMaskState({
  clientHeight,
  scrollHeight,
  scrollTop,
}: ScrollMetrics): ScrollMaskState {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  if (maxScrollTop <= SCROLL_MASK_THRESHOLD_PX) {
    return EMPTY_SCROLL_MASK_STATE;
  }

  return {
    showTop: scrollTop > SCROLL_MASK_THRESHOLD_PX,
    showBottom: scrollTop < maxScrollTop - SCROLL_MASK_THRESHOLD_PX,
  };
}

export function getVerticalScrollMaskStyle({
  showBottom,
  showTop,
}: ScrollMaskState): CSSProperties | undefined {
  if (!showTop && !showBottom) {
    return undefined;
  }

  const topStop = showTop
    ? `transparent 0px, black ${SCROLL_MASK_EDGE_SIZE_PX}px`
    : `black 0px, black ${SCROLL_MASK_EDGE_SIZE_PX}px`;
  const bottomStop = showBottom
    ? `black calc(100% - ${SCROLL_MASK_EDGE_SIZE_PX}px), transparent 100%`
    : `black calc(100% - ${SCROLL_MASK_EDGE_SIZE_PX}px), black 100%`;
  const maskImage = `linear-gradient(to bottom, ${topStop}, ${bottomStop})`;

  return {
    WebkitMaskImage: maskImage,
    maskImage,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskSize: "100% 100%",
    maskSize: "100% 100%",
  };
}

/** Thinking 与工具分组共用：容器拥有跟随状态，内容/容器变高时只在用户未离底时跟随。 */
export function useBottomFollowingScroll(active: boolean, contentVersion: unknown) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);
  const rafIdRef = useRef<number | null>(null);
  const [mask, setMask] = useState<ScrollMaskState>(EMPTY_SCROLL_MASK_STATE);
  const updateMask = useCallback(() => {
    const el = scrollRef.current;
    const next = el ? resolveVerticalScrollMaskState(el) : EMPTY_SCROLL_MASK_STATE;
    setMask((previous) =>
      previous.showTop === next.showTop && previous.showBottom === next.showBottom
        ? previous
        : next,
    );
  }, []);
  const syncNow = useCallback(() => {
    const el = scrollRef.current;
    if (el && followingRef.current) {
      const targetTop = Math.max(0, el.scrollHeight - el.clientHeight);
      if (Math.abs(el.scrollTop - targetTop) > 1) {
        el.scrollTop = targetTop;
      }
    }
    updateMask();
  }, [updateMask]);
  // 折叠/展开高度动画期间 ResizeObserver 会高频触发，按帧合并到单次 rAF 避免同步重排掉帧。
  const scheduleSync = useCallback(() => {
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      syncNow();
      return;
    }
    if (rafIdRef.current !== null) return;
    rafIdRef.current = window.requestAnimationFrame(() => {
      rafIdRef.current = null;
      syncNow();
    });
  }, [syncNow]);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    followingRef.current = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop) <= 2;
    updateMask();
  }, [updateMask]);
  useEffect(() => {
    if (!active) {
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      followingRef.current = true;
      setMask(EMPTY_SCROLL_MASK_STATE);
      return;
    }
    scheduleSync();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return () => {
        if (rafIdRef.current !== null) {
          window.cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
      };
    }
    const observer = new ResizeObserver(scheduleSync);
    observer.observe(el);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => {
      observer.disconnect();
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [active, scheduleSync]);
  useEffect(() => {
    if (active) scheduleSync();
  }, [active, contentVersion, scheduleSync]);
  const maskData = mask.showTop
    ? mask.showBottom
      ? "both"
      : "top"
    : mask.showBottom
      ? "bottom"
      : "none";
  return { scrollRef, contentRef, onScroll, maskData, maskStyle: getVerticalScrollMaskStyle(mask) };
}
