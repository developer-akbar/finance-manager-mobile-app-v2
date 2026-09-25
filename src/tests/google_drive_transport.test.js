/**
 * google_drive_transport.test.js
 * 
 * Automated Test Suite for Google Auth & Drive Transport Service:
 * - OAuth config resolution & missing Client ID guard
 * - Token caching & expiry validation
 * - Drive API v3 request construction (spaces=appDataFolder, multipart)
 * - Synthetic test payload encryption round-trip
 * - Mock transport lifecycle (Upload -> Read -> Update -> Delete)
 * - Zero local database mutation invariant
 * 
 * Runs in an isolated memory environment.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { initDB, getDB, closeDB } from '../database/db.js';
import { setSetting, getSetting } from '../database/settings.js';
import { getTransactions } from '../database/transactions.js';
import {
  getGoogleClientId,
  setGoogleClientId,
  getStoredToken,
  saveTokenData,
  clearGoogleAuth,
  signInWithGoogle,
  GOOGLE_DRIVE_APPDATA_SCOPE,
  STORAGE_KEY_TOKEN,
  STORAGE_KEY_EXPIRY
} from '../services/googleAuth.js';
import {
  findAppDataFile,
  readAppDataFile,
  uploadAppDataFile,
  deleteAppDataFile,
  testDriveTransport
} from '../services/googleDriveSync.js';
import { encryptBackupData, decryptBackupData } from '../utils/cryptoBackup.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    failed++;
    console.error(`❌ FAIL: ${message}`);
    throw new Error(message);
  } else {
    passed++;
    console.log(`✅ PASS: ${message}`);
  }
}

// Mock localStorage if in node environment
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) || null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  };
}

async function runTestSuite() {
  console.log('\n======================================================');
  console.log('   FINMAN GOOGLE AUTH & DRIVE TRANSPORT TEST SUITE');
  console.log('======================================================\n');

  closeDB();
  globalThis.indexedDB = new IDBFactory();
  await initDB();

  // ─────────────────────────────────────────────────────────────
  // TEST 1: Single Minimal OAuth Scope Verification
  // ─────────────────────────────────────────────────────────────
  console.log('--- Test 1: Single Minimal OAuth Scope Verification ---');
  assert(GOOGLE_DRIVE_APPDATA_SCOPE === 'https://www.googleapis.com/auth/drive.appdata', 'Scope is strictly drive.appdata');
  assert(!GOOGLE_DRIVE_APPDATA_SCOPE.includes('userinfo'), 'Scope does NOT contain userinfo');
  assert(!GOOGLE_DRIVE_APPDATA_SCOPE.includes('email'), 'Scope does NOT contain email');
  assert(!GOOGLE_DRIVE_APPDATA_SCOPE.includes('profile'), 'Scope does NOT contain profile');

  // ─────────────────────────────────────────────────────────────
  // TEST 2: Missing Client ID Guard
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 2: Missing Client ID Guard ---');
  await setGoogleClientId('');
  let authThrew = false;
  try {
    await signInWithGoogle();
  } catch (err) {
    authThrew = err.message.includes('Google OAuth Client ID is not configured');
  }
  assert(authThrew, 'signInWithGoogle rejects when Client ID is missing without calling APIs');

  // ─────────────────────────────────────────────────────────────
  // TEST 3: Custom Client ID Persistence
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 3: Custom Client ID Persistence ---');
  await setGoogleClientId('123456789-test.apps.googleusercontent.com');
  const configuredId = await getGoogleClientId();
  assert(configuredId === '123456789-test.apps.googleusercontent.com', 'Custom Client ID saved and retrieved');

  // ─────────────────────────────────────────────────────────────
  // TEST 4: Token Storage & Expiry Validation
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 4: Token Storage & Expiry Handling ---');
  clearGoogleAuth();
  assert(getStoredToken() === null, 'getStoredToken returns null when unauthenticated');

  // Store token expiring in 3600 seconds
  saveTokenData('mock_token_abc123', 3600);
  assert(getStoredToken() === 'mock_token_abc123', 'Valid unexpired token retrieved');

  // Store expired token (expiry in past)
  localStorage.setItem(STORAGE_KEY_EXPIRY, String(Date.now() - 5000));
  assert(getStoredToken() === null, 'Expired token correctly returns null');

  clearGoogleAuth();
  assert(localStorage.getItem(STORAGE_KEY_TOKEN) === null, 'clearGoogleAuth purges credentials');

  // ─────────────────────────────────────────────────────────────
  // TEST 5: Synthetic Payload Client-Side Encryption Round-Trip
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 5: Synthetic Test Payload Encryption Round-Trip ---');
  const syntheticPayload = {
    type: 'finman-cloud-sync-test',
    version: 1,
    createdAt: new Date().toISOString(),
    randomTestId: 'test-synthetic-999',
    message: 'FinMan Drive transport test'
  };
  const testPin = '8899';

  const encryptedCiphertext = await encryptBackupData(syntheticPayload, testPin);
  assert(typeof encryptedCiphertext === 'string' && encryptedCiphertext.length > 50, 'Payload encrypted to ciphertext');
  assert(!encryptedCiphertext.includes('test-synthetic-999'), 'Ciphertext does NOT leak plaintext fields');

  const decrypted = await decryptBackupData(encryptedCiphertext, testPin);
  assert(decrypted.randomTestId === 'test-synthetic-999', 'Decrypted payload matches exact test ID');
  assert(decrypted.message === 'FinMan Drive transport test', 'Decrypted message matches');

  // Wrong PIN must throw and fail
  let wrongPinFailed = false;
  try {
    await decryptBackupData(encryptedCiphertext, '0000');
  } catch {
    wrongPinFailed = true;
  }
  assert(wrongPinFailed, 'Decryption with wrong PIN throws authentication tag error');

  // ─────────────────────────────────────────────────────────────
  // TEST 6: Mock Drive Transport Lifecycle (Upload -> Read -> Update -> Delete)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 6: Mock Drive Transport API Lifecycle ---');

  // In-memory mock Drive appDataFolder storage
  const mockDriveStorage = new Map();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    const urlStr = String(url);
    const authHeader = options.headers?.Authorization || '';
    if (!authHeader.startsWith('Bearer mock_access_token')) {
      return { ok: false, status: 401, text: async () => 'Unauthorized' };
    }

    // 1. List / Find files
    if (urlStr.includes('/files?spaces=appDataFolder')) {
      const match = urlStr.match(/name%20%3D%20'([^']+)'/);
      const filename = match ? decodeURIComponent(match[1]) : '';
      const file = mockDriveStorage.get(filename);
      return {
        ok: true,
        status: 200,
        json: async () => ({ files: file ? [{ id: file.id, name: file.name, version: file.version }] : [] })
      };
    }

    // 2. Upload / Multipart
    if (urlStr.includes('/upload/drive/v3/files')) {
      const body = options.body || '';
      const metaMatch = body.match(/\{[\s\S]*?\}/);
      const meta = metaMatch ? JSON.parse(metaMatch[0]) : { name: 'unknown' };
      const contentParts = body.split(/--[-0-9]+/);
      const content = contentParts[contentParts.length - 2]?.split('\r\n\r\n')[1] || '';

      const fileObj = {
        id: 'file-mock-' + meta.name,
        name: meta.name,
        content: content.trim(),
        version: (mockDriveStorage.get(meta.name)?.version || 0) + 1
      };
      mockDriveStorage.set(meta.name, fileObj);
      return { ok: true, status: 200, json: async () => fileObj };
    }

    // 3. Read content (?alt=media)
    if (urlStr.includes('?alt=media')) {
      const idMatch = urlStr.match(/\/files\/([^?]+)/);
      const fileId = idMatch ? idMatch[1] : '';
      for (const f of mockDriveStorage.values()) {
        if (f.id === fileId) {
          return { ok: true, status: 200, text: async () => f.content };
        }
      }
      return { ok: false, status: 404, text: async () => 'File not found' };
    }

    // 4. Delete file
    if (options.method === 'DELETE') {
      const idMatch = urlStr.match(/\/files\/([^?]+)/);
      const fileId = idMatch ? idMatch[1] : '';
      for (const [name, f] of mockDriveStorage.entries()) {
        if (f.id === fileId) {
          mockDriveStorage.delete(name);
          return { ok: true, status: 204 };
        }
      }
      return { ok: false, status: 404 };
    }

    return { ok: false, status: 400, text: async () => 'Unknown mock route' };
  };

  try {
    const testResult = await testDriveTransport('mock_access_token', '9988');
    assert(testResult.success === true, 'Synthetic test transport executed successfully');
    assert(testResult.verifiedRoundTrip === true, 'Upload, read-back, and decryption round-trip verified');
    assert(testResult.fileDeleted === true, 'Test file safely deleted from Drive appDataFolder');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 7: Zero Local Database Mutation Invariant
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 7: Zero Local DB Mutation Invariant ---');
  const txns = await getTransactions();
  assert(txns.length === 0, 'No transactions created or modified by auth or transport tests');

  console.log('\n======================================================');
  console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) process.exit(1);
}

runTestSuite().catch(err => {
  console.error('Fatal Test Error:', err);
  process.exit(1);
});
