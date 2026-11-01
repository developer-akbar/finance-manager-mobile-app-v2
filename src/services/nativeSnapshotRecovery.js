/**
 * nativeSnapshotRecovery.js — Native Android Snapshot Recovery Bridge (Phase B)
 *
 * Coordinates memory-safe native streaming download, chunked Base64 decoding,
 * AES-256-GCM decryption with full tag verification, and SQLite staging.
 */

import { registerPlugin, Capacitor } from '@capacitor/core';

export const NativeSnapshotRecovery = registerPlugin('NativeSnapshotRecovery');

/**
 * Check whether native snapshot recovery is supported on this platform (Android native).
 */
export function isNativeSnapshotRecoverySupported() {
  if (typeof window !== 'undefined') {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      return true;
    }
  }
  return false;
}

/**
 * Downloads, decrypts, and stages snapshot into a temporary SQLite database on Android.
 *
 * @param {Object} options
 * @param {string} [options.fileId] Google Drive file ID
 * @param {string} [options.accessToken] Google OAuth Bearer access token
 * @param {string} [options.sourceFilePath] Local file path (for offline testing)
 * @param {string} options.pin PIN for PBKDF2 AES-256-GCM decryption
 * @returns {Promise<Object>} Staging metadata including stagingDbPath and entityCounts
 */
export async function prepareStagingSnapshotNative(options = {}) {
  if (!isNativeSnapshotRecoverySupported()) {
    throw new Error('Native snapshot recovery is only supported on Android native devices.');
  }
  return await NativeSnapshotRecovery.prepareStagingSnapshot(options);
}

/**
 * Cleans up temporary staging SQLite database after promotion.
 *
 * @param {string} stagingDbPath Path to the staging SQLite database
 */
export async function cleanupStagingSnapshotNative(stagingDbPath) {
  if (!stagingDbPath || !isNativeSnapshotRecoverySupported()) return;
  try {
    await NativeSnapshotRecovery.cleanupStagingSnapshot({ stagingDbPath });
  } catch (err) {
    console.warn('[NativeSnapshotRecovery] Cleanup warning:', err?.message);
  }
}

/**
 * Verification test helper for unit tests
 */
export async function testVerifyCryptoNative(params) {
  if (!isNativeSnapshotRecoverySupported()) {
    throw new Error('Native crypto verification is only available on Android native devices.');
  }
  return await NativeSnapshotRecovery.testVerifyCrypto(params);
}
