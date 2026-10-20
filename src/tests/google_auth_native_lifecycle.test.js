import test from 'node:test';
import assert from 'node:assert/strict';

import {
  saveTokenData,
  getStoredToken,
  isGoogleLinked,
  setGoogleLinked,
  clearGoogleAuth,
  isNativeAuthSupported,
  signInWithGoogle,
  AUTH_WATCHDOG_TIMEOUT_MS,
  STORAGE_KEY_TOKEN,
  STORAGE_KEY_EXPIRY,
  STORAGE_KEY_LINKED,
  STORAGE_KEY_EMAIL,
  STORAGE_KEY_DISPLAY_NAME,
  GoogleAuthBridge,
  setNativeAuthBridge,
  signInWithGoogleNative,
  refreshNativeToken,
  getStoredGoogleUser
} from '../services/googleAuth.js';

// Setup minimal localStorage mock for testing
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) || null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
  };
}

test('Google Auth - Token Storage Validation & Safety', async (t) => {
  localStorage.clear();

  await t.test('refuses to save empty, null, or whitespace access tokens', () => {
    assert.throws(() => saveTokenData(null), /Refusing to save/);
    assert.throws(() => saveTokenData(''), /Refusing to save/);
    assert.throws(() => saveTokenData('   '), /Refusing to save/);
    assert.equal(isGoogleLinked(), false);
    assert.equal(getStoredToken(), null);
  });

  await t.test('saves valid access token and updates link state', () => {
    const validToken = 'ya29.a0ARrdaM8-valid-oauth-bearer-token-sample-value-123456';
    saveTokenData(validToken, 3600);

    assert.equal(isGoogleLinked(), true);
    assert.equal(getStoredToken(), validToken);
    assert.ok(parseInt(localStorage.getItem(STORAGE_KEY_EXPIRY), 10) > Date.now());
  });

  await t.test('clearGoogleAuth clears tokens and resets linked state', () => {
    clearGoogleAuth();
    assert.equal(isGoogleLinked(), false);
    assert.equal(getStoredToken(), null);
    assert.equal(localStorage.getItem(STORAGE_KEY_TOKEN), null);
    assert.equal(localStorage.getItem(STORAGE_KEY_EXPIRY), null);
  });
});

test('Google Auth - Watchdog Timeout & AbortSignal Cancellation', async (t) => {
  localStorage.clear();
  process.env.VITE_GOOGLE_CLIENT_ID = 'test-mock-client-id.apps.googleusercontent.com';

  await t.test('aborts immediately when AbortSignal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => {
        await signInWithGoogle({ signal: controller.signal });
      },
      (err) => {
        assert.match(err.message, /cancelled/i);
        return true;
      }
    );
    assert.equal(isGoogleLinked(), false);
  });

  await t.test('aborts when AbortSignal fires during pending authentication', async () => {
    // Mock minimal window.google.accounts.oauth2 to simulate an in-flight pending auth request
    const prevWindow = globalThis.window;
    globalThis.window = {
      google: {
        accounts: {
          oauth2: {
            initTokenClient: () => ({
              requestAccessToken: () => {} // hangs pending like real life
            })
          }
        }
      }
    };

    try {
      const controller = new AbortController();
      const authPromise = signInWithGoogle({ signal: controller.signal });

      // Abort after small delay while pending
      setTimeout(() => {
        controller.abort();
      }, 20);

      await assert.rejects(
        async () => {
          await authPromise;
        },
        (err) => {
          assert.match(err.message, /cancelled/i);
          return true;
        }
      );
      assert.equal(isGoogleLinked(), false);
    } finally {
      globalThis.window = prevWindow;
    }
  });
});

test('Google Auth - Platform Environment Detection', () => {
  // In Node.js unit tests, native platform should evaluate to false
  const isNative = isNativeAuthSupported();
  assert.equal(typeof isNative, 'boolean');
  assert.equal(isNative, false);
});

test('Google Auth - Native Bridge Operations & Refresh Lifecycle', async (t) => {
  localStorage.clear();

  await t.test('signInWithGoogleNative saves tokens and user profile', async () => {
    setNativeAuthBridge({
      signIn: async () => ({
        accessToken: 'ya29.sample-native-bearer-token-1234567890',
        expiresIn: 3600,
        email: 'native.user@example.com',
        displayName: 'Native User'
      })
    });

    try {
      const res = await signInWithGoogleNative('test-client-id');
      assert.equal(res.accessToken, 'ya29.sample-native-bearer-token-1234567890');
      assert.equal(isGoogleLinked(), true);
      assert.equal(getStoredToken(), 'ya29.sample-native-bearer-token-1234567890');

      const user = getStoredGoogleUser();
      assert.equal(user.email, 'native.user@example.com');
      assert.equal(user.displayName, 'Native User');
    } finally {
      setNativeAuthBridge(null);
    }
  });

  await t.test('refreshNativeToken silently retrieves and stores fresh token', async () => {
    setNativeAuthBridge({
      refresh: async () => ({
        accessToken: 'ya29.refreshed-silent-bearer-token-9876543210',
        expiresIn: 3600,
        email: 'native.user@example.com',
        displayName: 'Native User'
      })
    });

    try {
      const freshToken = await refreshNativeToken();
      assert.equal(freshToken, 'ya29.refreshed-silent-bearer-token-9876543210');
      assert.equal(getStoredToken(), 'ya29.refreshed-silent-bearer-token-9876543210');
      assert.equal(isGoogleLinked(), true);
    } finally {
      setNativeAuthBridge(null);
    }
  });

  await t.test('native sign-in error does not mutate state or link account', async () => {
    clearGoogleAuth();
    setNativeAuthBridge({
      signIn: async () => {
        const err = new Error('User cancelled sign-in');
        err.code = '12501';
        throw err;
      }
    });

    try {
      await assert.rejects(
        async () => {
          await signInWithGoogleNative('test-client-id');
        },
        /User cancelled/
      );
      assert.equal(isGoogleLinked(), false);
      assert.equal(getStoredToken(), null);
    } finally {
      setNativeAuthBridge(null);
    }
  });
});
