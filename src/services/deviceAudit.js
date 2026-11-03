/**
 * deviceAudit.js — Transaction Device Audit Trail & Provenance Registry
 *
 * Provides stable device ID tracking and dynamic device name resolution for
 * transaction audit trails in Developer Debug Info.
 *
 * Rules:
 * - Immutable device IDs are the source of truth, never device names.
 * - Dynamic resolution checks user nicknames, then cloud/manifest registry,
 *   falling back to raw device ID if name is unknown.
 * - Missing/null device IDs are classified as legacy (Unknown (Legacy)).
 * - Historical device IDs survive device removal from registry.
 */

let _cachedDeviceId = null;
const _memoryRegistry = new Map();
const _memoryNicknames = new Map();

/**
 * Returns or retrieves the persistent local device ID.
 * Caches the result in-memory and in localStorage.
 *
 * @returns {Promise<string|null>}
 */
export async function getCurrentDeviceId() {
  if (_cachedDeviceId && _cachedDeviceId !== 'local_device') {
    return _cachedDeviceId;
  }

  // Check localStorage first for synchronous fast-path
  if (typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem('finman_local_device_id');
      if (stored && stored !== 'local_device') {
        _cachedDeviceId = stored;
        return stored;
      }
    } catch {}
  }

  try {
    const { getOrCreateLocalDeviceId } = await import('./deltaSyncCoordinator.js');
    const id = await getOrCreateLocalDeviceId();
    if (id && id !== 'local_device') {
      _cachedDeviceId = id;
      if (typeof localStorage !== 'undefined') {
        try { localStorage.setItem('finman_local_device_id', id); } catch {}
      }
      return id;
    }
  } catch (err) {
    console.warn('[DeviceAudit] Could not determine local device ID:', err?.message);
  }

  return null;
}

/**
 * Explicitly sets or overrides the local device ID (used in tests or profile switch).
 *
 * @param {string|null} id
 */
export function setCachedLocalDeviceId(id) {
  _cachedDeviceId = id || null;
  if (typeof localStorage !== 'undefined') {
    try {
      if (id) {
        localStorage.setItem('finman_local_device_id', id);
      } else {
        localStorage.removeItem('finman_local_device_id');
      }
    } catch {}
  }
}

/**
 * Registers or updates a device's name in the registry cache.
 *
 * @param {string} deviceId
 * @param {string} deviceName
 */
export function registerDeviceAuditName(deviceId, deviceName) {
  if (!deviceId || !deviceName) return;
  const cleanId = String(deviceId).trim();
  const cleanName = String(deviceName).trim();
  if (!cleanId || !cleanName) return;

  _memoryRegistry.set(cleanId, cleanName);

  if (typeof localStorage !== 'undefined') {
    try {
      const reg = JSON.parse(localStorage.getItem('finman_device_registry_cache') || '{}');
      reg[cleanId] = cleanName;
      localStorage.setItem('finman_device_registry_cache', JSON.stringify(reg));
    } catch {}
  }
}

/**
 * Sets or removes a user-defined device nickname.
 *
 * @param {string} deviceId
 * @param {string|null} nickname
 */
export function setDeviceNickname(deviceId, nickname) {
  if (!deviceId) return;
  const cleanId = String(deviceId).trim();
  const trimmed = nickname ? String(nickname).trim() : '';

  if (trimmed) {
    _memoryNicknames.set(cleanId, trimmed);
  } else {
    _memoryNicknames.delete(cleanId);
  }

  if (typeof localStorage !== 'undefined') {
    try {
      const nicks = JSON.parse(localStorage.getItem('finman_device_nicknames') || '{}');
      if (trimmed) {
        nicks[cleanId] = trimmed;
      } else {
        delete nicks[cleanId];
      }
      localStorage.setItem('finman_device_nicknames', JSON.stringify(nicks));
    } catch {}
  }
}

/**
 * Bulk updates the device registry cache from discovered device manifests.
 *
 * @param {Array<Object>|Map<string, Object>} devices
 */
export function cacheDeviceRegistry(devices) {
  if (!devices) return;
  const deviceList = Array.isArray(devices) ? devices : Array.from(devices.values ? devices.values() : []);
  for (const d of deviceList) {
    const id = d.deviceId || d.device_id;
    const name = d.deviceName || d.device_name;
    if (id && name) {
      registerDeviceAuditName(id, name);
    }
  }
}

/**
 * Dynamically resolves a stored device ID against known nicknames and manifest registry.
 *
 * Resolution Rules:
 * 1. If device ID is missing, null, undefined, or 'Unknown'/'local_device', returns isLegacy: true.
 * 2. Checks user-defined nicknames (highest priority for renamed devices).
 * 3. Checks registered manifest device names.
 * 4. If current local device and no name recorded, defaults to 'FinMan Web' / 'FinMan Android'.
 * 5. If device is not in registry (e.g. removed or unknown peer), preserves and returns the deviceId.
 *
 * @param {string|null|undefined} deviceId
 * @returns {{ deviceId: string|null, deviceName: string|null, isLegacy: boolean }}
 */
export function resolveDeviceAuditInfo(deviceId) {
  if (!deviceId || deviceId === 'Unknown' || deviceId === 'local_device') {
    return {
      deviceId: null,
      deviceName: null,
      isLegacy: true
    };
  }

  const cleanId = String(deviceId).trim();
  if (!cleanId) {
    return {
      deviceId: null,
      deviceName: null,
      isLegacy: true
    };
  }

  // 1. Check user-defined nicknames
  let nickname = _memoryNicknames.get(cleanId);
  if (!nickname && typeof localStorage !== 'undefined') {
    try {
      const nicks = JSON.parse(localStorage.getItem('finman_device_nicknames') || '{}');
      if (nicks[cleanId]) nickname = nicks[cleanId];
    } catch {}
  }

  // 2. Check cached manifest device registry
  let registryName = _memoryRegistry.get(cleanId);
  if (!registryName && typeof localStorage !== 'undefined') {
    try {
      const reg = JSON.parse(localStorage.getItem('finman_device_registry_cache') || '{}');
      if (reg[cleanId]) registryName = reg[cleanId];
    } catch {}
  }

  let deviceName = nickname || registryName || null;

  // 3. Fallback for local device if not explicitly named
  if (!deviceName) {
    let localId = _cachedDeviceId;
    if (!localId && typeof localStorage !== 'undefined') {
      try {
        localId = localStorage.getItem('finman_local_device_id');
      } catch {}
    }
    if (localId && localId === cleanId) {
      deviceName = (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.())
        ? 'FinMan Android'
        : 'FinMan Web';
    }
  }

  return {
    deviceId: cleanId,
    deviceName,
    isLegacy: false
  };
}

/**
 * Clears the in-memory and cached device registry (for test hygiene).
 */
export function clearDeviceAuditRegistry() {
  _memoryRegistry.clear();
  _memoryNicknames.clear();
  _cachedDeviceId = null;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem('finman_device_registry_cache');
      localStorage.removeItem('finman_device_nicknames');
      localStorage.removeItem('finman_local_device_id');
    } catch {}
  }
}

