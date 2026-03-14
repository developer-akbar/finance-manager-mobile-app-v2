import { useRef, useCallback } from 'react';

/**
 * useSwipe — detects horizontal swipes on touch devices.
 * onSwipeLeft  → user swiped left  → go forward (next period)
 * onSwipeRight → user swiped right → go back    (prev period)
 */
export default function useSwipe(onSwipeLeft, onSwipeRight, minDist = 48) {
  const startX = useRef(null);
  const startY = useRef(null);

  const onTouchStart = useCallback((e) => {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
  }, []);

  const onTouchEnd = useCallback((e) => {
    if (startX.current === null) return;
    const dx = e.changedTouches[0].clientX - startX.current;
    const dy = e.changedTouches[0].clientY - startY.current;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) >= minDist) {
      if (dx < 0) onSwipeLeft?.();
      else        onSwipeRight?.();
    }
    startX.current = null;
    startY.current = null;
  }, [onSwipeLeft, onSwipeRight, minDist]);

  return { onTouchStart, onTouchEnd };
}
