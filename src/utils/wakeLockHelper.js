/**
 * wakeLockHelper.js — Screen Wake Lock Utility for FinMan
 *
 * Prevents device screen from dimming/locking during critical sync and snapshot publish operations.
 * Uses:
 * 1. Native Android WindowManager FLAG_KEEP_SCREEN_ON via GoogleAuthBridge
 * 2. W3C Screen Wake Lock API (navigator.wakeLock)
 */

let _webWakeLock = null;

export async function setKeepScreenOn(enabled = true) {
  // 1. Try Native Capacitor Bridge (Android)
  try {
    const { Capacitor, registerPlugin } = await import('@capacitor/core');
    if (Capacitor && typeof Capacitor.isNativePlatform === 'function' && Capacitor.isNativePlatform()) {
      const bridge = registerPlugin('GoogleAuthBridge');
      if (bridge && typeof bridge.setKeepScreenOn === 'function') {
        await bridge.setKeepScreenOn({ enabled });
      }
    }
  } catch (err) {
    // Ignore native bridge errors in non-native environments
  }

  // 2. Try W3C Screen Wake Lock API
  if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && typeof navigator.wakeLock.request === 'function') {
    try {
      if (enabled) {
        if (!_webWakeLock) {
          _webWakeLock = await navigator.wakeLock.request('screen');
          _webWakeLock.addEventListener('release', () => {
            _webWakeLock = null;
          });
        }
      } else {
        if (_webWakeLock) {
          await _webWakeLock.release();
          _webWakeLock = null;
        }
      }
    } catch (err) {
      // Ignore if wake lock cannot be acquired (e.g. low battery, non-visible tab)
    }
  }
}
