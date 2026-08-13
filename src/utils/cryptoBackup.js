/**
 * cryptoBackup.js — Zero-Knowledge AES-256-GCM Backup & Restore Utility
 * Uses Web Crypto API (PBKDF2 + AES-GCM) with 100,000 iterations for secure password-derived encryption.
 */

// Helper to convert string to ArrayBuffer
function str2ab(str) {
  const enc = new TextEncoder();
  return enc.encode(str);
}

// Helper to convert ArrayBuffer to string
function ab2str(buf) {
  const dec = new TextDecoder();
  return dec.decode(buf);
}

// Safe chunked conversion from Uint8Array to base64 (avoids Maximum call stack size exceeded)
function bytesToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// Safe conversion from base64 to Uint8Array
function base64ToBytes(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Derive AES-256 key from PIN/password + salt using PBKDF2
async function deriveKey(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    str2ab(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt entire application payload with password/PIN
 * Returns a JSON string containing base64 encoded salt, IV, ciphertext, and metadata.
 */
export async function encryptBackupData(dataObj, password) {
  if (!password || !password.trim()) {
    throw new Error('Please provide a password or PIN for encryption');
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password.trim(), salt);

  const jsonStr = JSON.stringify({
    version: '2.3.0',
    app: 'FinMan',
    exportedAt: new Date().toISOString(),
    payload: dataObj,
  });

  const encryptedBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    str2ab(jsonStr)
  );

  // Package into exportable container
  const backupPackage = {
    finman_encrypted_backup: true,
    version: 1,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encryptedBuf)),
    created_at: new Date().toISOString(),
  };

  return JSON.stringify(backupPackage, null, 2);
}

/**
 * Decrypt application payload with password/PIN
 */
export async function decryptBackupData(backupJsonString, password) {
  if (!password || !password.trim()) {
    throw new Error('Please enter the password or PIN to decrypt');
  }

  let pkg;
  try {
    pkg = JSON.parse(backupJsonString);
  } catch {
    throw new Error('Invalid backup file format');
  }

  if (!pkg || !pkg.finman_encrypted_backup || !pkg.salt || !pkg.iv || !pkg.data) {
    throw new Error('Unrecognized or corrupted FinMan encrypted backup file');
  }

  const salt = base64ToBytes(pkg.salt);
  const iv = base64ToBytes(pkg.iv);
  const ciphertext = base64ToBytes(pkg.data);

  const key = await deriveKey(password.trim(), salt);

  try {
    const decryptedBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    const decryptedStr = ab2str(decryptedBuf);
    const result = JSON.parse(decryptedStr);
    return result.payload || result;
  } catch (err) {
    throw new Error('Incorrect password/PIN or corrupted backup data');
  }
}
