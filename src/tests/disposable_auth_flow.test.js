/**
 * disposable_auth_flow.test.js
 * 
 * Offline Verification Suite for Disposable Account OAuth 2.0 PKCE Authentication.
 * 
 * Strict Isolation: Zero live network requests, zero browser popups, zero writes to real .env.local.
 * 
 * Verifies:
 * 1. PKCE verifier generation and S256 challenge derivation
 * 2. Authorization URL construction, parameter binding, and strict scope restriction (drive.appdata only)
 * 3. Loopback server bound strictly to 127.0.0.1
 * 4. State mismatch rejection (CSRF protection fails closed)
 * 5. OAuth denial handling (error=access_denied)
 * 6. Invalid callback handling (invalid paths, non-GET methods, missing code)
 * 7. Server timeout handling
 * 8. Successful callback handling and clean server termination
 * 9. Token exchange with PKCE code_verifier
 * 10. Identity verification and production account rejection
 * 11. User confirmation rejection (abort if unconfirmed)
 * 12. Account mismatch safety abort against configured expected account
 * 13. Existing .env.local overwrite prevention
 * 14. Authorized .env.local write with restrictive file permissions (0o600)
 * 15. Secret redaction in logs and error traces
 * 16. End-to-end pipeline execution with injected mocks
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  GOOGLE_DRIVE_APPDATA_SCOPE,
  maskEmail,
  sanitizeErrorMessage,
  generatePkcePair,
  generateRandomState,
  buildAuthorizationUrl,
  createLoopbackServer,
  exchangeCodeForToken,
  fetchDriveUserInfo,
  verifyIdentityAndConfirm,
  writeEnvLocalCredentials,
  runInteractiveAuthentication
} from '../../scripts/authenticate_disposable.mjs';

const MOCK_CLIENT_ID = 'test-client-id-12345.apps.googleusercontent.com';
const DISPOSABLE_EMAIL = 'finman.disposable.tester@gmail.com';
const PRODUCTION_EMAIL = 'akbar.ak219@gmail.com';

test('Disposable Account OAuth 2.0 PKCE Authentication Suite', async (t) => {

  await t.test('1. PKCE Generation — Valid RFC 7636 verifier and S256 challenge', () => {
    const pkce = generatePkcePair();
    assert.ok(pkce.codeVerifier, 'Must generate codeVerifier');
    assert.ok(pkce.codeChallenge, 'Must generate codeChallenge');
    assert.equal(pkce.codeChallengeMethod, 'S256');

    // RFC 7636: verifier length between 43 and 128 characters
    assert.ok(pkce.codeVerifier.length >= 43 && pkce.codeVerifier.length <= 128, 'Verifier length must be 43-128 chars');
    assert.match(pkce.codeVerifier, /^[A-Za-z0-9_-]+$/, 'Verifier must be URL-safe base64url');

    // Mathematically verify challenge equals base64url SHA-256 of verifier
    const expectedChallenge = crypto
      .createHash('sha256')
      .update(pkce.codeVerifier)
      .digest('base64url');
    assert.equal(pkce.codeChallenge, expectedChallenge, 'Challenge must be exact SHA-256 base64url hash of verifier');

    // Random state test
    const state1 = generateRandomState();
    const state2 = generateRandomState();
    assert.ok(state1 && state2);
    assert.notEqual(state1, state2, 'State must be cryptographically random');
    assert.equal(state1.length, 48, 'State must have sufficient entropy');
  });

  await t.test('2. Authorization URL — Minimal scope, root loopback redirect, offline access, and consent prompt', () => {
    const pkce = generatePkcePair();
    const state = generateRandomState();
    const redirectUri = 'http://127.0.0.1:8085';

    const authUrl = buildAuthorizationUrl({
      clientId: MOCK_CLIENT_ID,
      redirectUri,
      state,
      codeChallenge: pkce.codeChallenge
    });

    const parsed = new URL(authUrl);
    assert.equal(parsed.origin, 'https://accounts.google.com');
    assert.equal(parsed.pathname, '/o/oauth2/v2/auth');

    const params = parsed.searchParams;
    assert.equal(params.get('client_id'), MOCK_CLIENT_ID);
    assert.equal(params.get('redirect_uri'), redirectUri);
    assert.equal(params.get('response_type'), 'code');
    assert.equal(params.get('state'), state);
    assert.equal(params.get('code_challenge'), pkce.codeChallenge);
    assert.equal(params.get('code_challenge_method'), 'S256');

    // Minimum scope enforcement
    assert.equal(params.get('scope'), GOOGLE_DRIVE_APPDATA_SCOPE, 'Must request ONLY drive.appdata');

    // Account picker & consent enforcement
    assert.ok(params.get('prompt').includes('select_account'), 'Must force select_account');
    assert.ok(params.get('prompt').includes('consent'), 'Must force consent for refresh token generation');

    // Offline access requested for refresh token
    assert.equal(params.get('access_type'), 'offline', 'Must request offline access for refresh token');

    // Rejection of invalid scope
    assert.throws(
      () => buildAuthorizationUrl({
        clientId: MOCK_CLIENT_ID,
        redirectUri,
        state,
        codeChallenge: pkce.codeChallenge,
        scope: 'https://www.googleapis.com/auth/drive'
      }),
      /SCOPE_VIOLATION_ERROR/,
      'Must reject broader scopes'
    );

    // Rejection of non-127.0.0.1 host (e.g. 0.0.0.0 or external hostname)
    assert.throws(
      () => buildAuthorizationUrl({
        clientId: MOCK_CLIENT_ID,
        redirectUri: 'http://localhost:8085',
        state,
        codeChallenge: pkce.codeChallenge
      }),
      /SECURITY_VIOLATION/,
      'Must reject localhost in favor of explicit 127.0.0.1'
    );

    assert.throws(
      () => buildAuthorizationUrl({
        clientId: MOCK_CLIENT_ID,
        redirectUri: 'http://0.0.0.0:8085',
        state,
        codeChallenge: pkce.codeChallenge
      }),
      /SECURITY_VIOLATION/,
      'Must reject 0.0.0.0'
    );
  });

  await t.test('3. Loopback Server — Bound strictly to IPv4 127.0.0.1', async () => {
    const state = generateRandomState();
    // Port 0 picks an ephemeral available loopback port
    const loopback = await createLoopbackServer({
      port: 0,
      expectedState: state
    });

    try {
      const address = loopback.server.address();
      assert.equal(address.address, '127.0.0.1', 'Server must be bound strictly to 127.0.0.1');
      assert.ok(address.port > 0, 'Must have allocated port');
      assert.equal(loopback.redirectUri, `http://127.0.0.1:${address.port}`);
    } finally {
      await loopback.close();
    }
  });

  await t.test('4. Loopback Server — State Mismatch (CSRF Protection)', async () => {
    const expectedState = generateRandomState();
    const wrongState = generateRandomState();
    const loopback = await createLoopbackServer({
      port: 0,
      expectedState
    });

    try {
      const waitPromise = loopback.waitForCallback();
      // Simulate OAuth callback with wrong state
      const callbackUrl = `http://127.0.0.1:${loopback.port}/?code=mock_code_123&state=${wrongState}`;
      const res = await fetch(callbackUrl);

      assert.equal(res.status, 400, 'Must return HTTP 400 on state mismatch');
      const text = await res.text();
      assert.ok(text.includes('State Mismatch'), 'Response body must explain state mismatch');

      await assert.rejects(
        waitPromise,
        /STATE_MISMATCH_ERROR/,
        'Must reject waitForCallback() promise on state mismatch'
      );
    } finally {
      await loopback.close();
    }
  });

  await t.test('5. Loopback Server — OAuth Denial (error=access_denied)', async () => {
    const expectedState = generateRandomState();
    const loopback = await createLoopbackServer({
      port: 0,
      expectedState
    });

    try {
      const waitPromise = loopback.waitForCallback();
      const callbackUrl = `http://127.0.0.1:${loopback.port}/?error=access_denied&error_description=User+cancelled&state=${expectedState}`;
      const res = await fetch(callbackUrl);

      assert.equal(res.status, 400, 'Must return HTTP 400 on OAuth denial');
      const text = await res.text();
      assert.ok(text.includes('Authentication Denied'), 'Response body must explain denial');

      await assert.rejects(
        waitPromise,
        /OAUTH_ACCESS_DENIED/,
        'Must reject waitForCallback() promise on OAuth denial'
      );
    } finally {
      await loopback.close();
    }
  });

  await t.test('6. Loopback Server — Invalid Callback (Paths, Methods, Missing Code)', async () => {
    const expectedState = generateRandomState();
    const loopback = await createLoopbackServer({
      port: 0,
      expectedState
    });

    try {
      // 1. Unrelated path (e.g. /favicon.ico) returns 404 and does not close loopback
      const faviconRes = await fetch(`http://127.0.0.1:${loopback.port}/favicon.ico`);
      assert.equal(faviconRes.status, 404, 'Must return 404 for unrelated paths');

      // 2. Non-GET method returns 405 Method Not Allowed
      const postRes = await fetch(`http://127.0.0.1:${loopback.port}/`, {
        method: 'POST'
      });
      assert.equal(postRes.status, 405, 'Must return 405 for POST request');

      // 3. Callback with valid state but missing code
      const waitPromise = loopback.waitForCallback();
      const noCodeRes = await fetch(`http://127.0.0.1:${loopback.port}/?state=${expectedState}`);
      assert.equal(noCodeRes.status, 400, 'Must return 400 when authorization code is missing');

      await assert.rejects(
        waitPromise,
        /MISSING_AUTH_CODE_ERROR/,
        'Must reject when authorization code is missing'
      );
    } finally {
      await loopback.close();
    }
  });

  await t.test('7. Loopback Server — Timeout Handling', async () => {
    const expectedState = generateRandomState();
    const loopback = await createLoopbackServer({
      port: 0,
      expectedState,
      timeoutMs: 50 // Fast timeout for test
    });

    try {
      await assert.rejects(
        loopback.waitForCallback(),
        /AUTH_TIMEOUT_ERROR/,
        'Must reject on authorization timeout'
      );
    } finally {
      await loopback.close();
    }
  });

  await t.test('8. Loopback Server — Successful Authorization Callback', async () => {
    const expectedState = generateRandomState();
    const loopback = await createLoopbackServer({
      port: 0,
      expectedState
    });

    try {
      const callbackUrl = `http://127.0.0.1:${loopback.port}/?code=mock_valid_auth_code_999&state=${expectedState}`;
      const res = await fetch(callbackUrl);

      assert.equal(res.status, 200, 'Must return HTTP 200 on success');
      const text = await res.text();
      assert.ok(text.includes('Authentication Successful'), 'Response body must confirm success');

      const result = await loopback.waitForCallback();
      assert.equal(result.code, 'mock_valid_auth_code_999', 'Must resolve received authorization code');
    } finally {
      await loopback.close();
    }
  });

  await t.test('9. Token Exchange — PKCE Code Verifier Exchange', async () => {
    let capturedBody = null;
    let capturedHeaders = null;

    const mockFetch = async (url, options) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      capturedHeaders = options.headers;
      capturedBody = new URLSearchParams(options.body);

      return {
        ok: true,
        json: async () => ({
          access_token: 'mock_access_token_xyz_888',
          refresh_token: '1//mock_refresh_token_xyz_999',
          expires_in: 3599,
          token_type: 'Bearer'
        })
      };
    };

    const tokenRes = await exchangeCodeForToken({
      code: 'mock_code_123',
      codeVerifier: 'mock_verifier_xyz_43_characters_long_base64url',
      clientId: MOCK_CLIENT_ID,
      redirectUri: 'http://127.0.0.1:8085',
      fetchFn: mockFetch
    });

    assert.equal(tokenRes.accessToken, 'mock_access_token_xyz_888');
    assert.equal(tokenRes.refreshToken, '1//mock_refresh_token_xyz_999');
    assert.equal(tokenRes.expiresIn, 3599);
    assert.equal(capturedBody.get('grant_type'), 'authorization_code');
    assert.equal(capturedBody.get('client_id'), MOCK_CLIENT_ID);
    assert.equal(capturedBody.get('code'), 'mock_code_123');
    assert.equal(capturedBody.get('code_verifier'), 'mock_verifier_xyz_43_characters_long_base64url');
    assert.equal(capturedBody.get('redirect_uri'), 'http://127.0.0.1:8085');
    assert.equal(capturedBody.get('client_secret'), null, 'Must omit client_secret when not provided');

    // Test token exchange with client_secret provided
    await exchangeCodeForToken({
      code: 'mock_code_123',
      codeVerifier: 'mock_verifier_xyz_43_characters_long_base64url',
      clientId: MOCK_CLIENT_ID,
      clientSecret: 'GOCSPX-mock_secret_key_123',
      redirectUri: 'http://127.0.0.1:8085',
      fetchFn: mockFetch
    });
    assert.equal(capturedBody.get('client_secret'), 'GOCSPX-mock_secret_key_123', 'Must include client_secret in POST body when provided');

    // Test token exchange error handling
    const failingFetch = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Code expired' })
    });

    await assert.rejects(
      exchangeCodeForToken({
        code: 'bad_code',
        codeVerifier: 'verifier',
        clientId: MOCK_CLIENT_ID,
        redirectUri: 'http://127.0.0.1:8085',
        fetchFn: failingFetch
      }),
      /TOKEN_EXCHANGE_FAILED/,
      'Must reject on token endpoint error'
    );
  });

  await t.test('10. Identity Verification — Production Account Rejection', async () => {
    // 1. Direct production email
    const mockProdUserInfo = async () => ({
      emailAddress: PRODUCTION_EMAIL,
      displayName: 'Production Account'
    });

    await assert.rejects(
      verifyIdentityAndConfirm({
        accessToken: 'mock_token',
        fetchUserInfoFn: mockProdUserInfo,
        promptFn: async () => true
      }),
      /PRODUCTION_ACCOUNT_DETECTED/,
      'Must reject known production email'
    );

    // 2. Identifier containing 'production'
    const mockProdKeywordUserInfo = async () => ({
      emailAddress: 'finman-production-backup@gmail.com',
      displayName: 'Production Backup'
    });

    await assert.rejects(
      verifyIdentityAndConfirm({
        accessToken: 'mock_token',
        fetchUserInfoFn: mockProdKeywordUserInfo,
        promptFn: async () => true
      }),
      /PRODUCTION_ACCOUNT_DETECTED/,
      'Must reject email containing "production"'
    );
  });

  await t.test('11. Identity Verification — User Confirmation Rejection', async () => {
    const mockDisposableUserInfo = async () => ({
      emailAddress: DISPOSABLE_EMAIL,
      displayName: 'Disposable Test Account'
    });

    // User prompt returns false (declined confirmation)
    await assert.rejects(
      verifyIdentityAndConfirm({
        accessToken: 'mock_token',
        fetchUserInfoFn: mockDisposableUserInfo,
        promptFn: async () => false
      }),
      /IDENTITY_CONFIRMATION_REJECTED/,
      'Must abort when user does not explicitly confirm disposable identity'
    );
  });

  await t.test('12. Identity Verification — Account Mismatch Safety Abort', async () => {
    const mockUserInfo = async () => ({
      emailAddress: 'other-unrelated-account@gmail.com',
      displayName: 'Other User'
    });

    await assert.rejects(
      verifyIdentityAndConfirm({
        accessToken: 'mock_token',
        expectedAccount: DISPOSABLE_EMAIL,
        fetchUserInfoFn: mockUserInfo,
        promptFn: async () => true
      }),
      /ACCOUNT_MISMATCH_SAFETY_ABORT/,
      'Must abort when authenticated email differs from configured expectedAccount'
    );

    // Verify success when email matches and user confirms
    const verified = await verifyIdentityAndConfirm({
      accessToken: 'mock_token',
      expectedAccount: DISPOSABLE_EMAIL,
      fetchUserInfoFn: async () => ({
        emailAddress: DISPOSABLE_EMAIL,
        displayName: 'Disposable Tester'
      }),
      promptFn: async () => true
    });

    assert.equal(verified.authenticatedEmail, DISPOSABLE_EMAIL);
    assert.equal(verified.maskedEmail, maskEmail(DISPOSABLE_EMAIL));
    assert.equal(verified.displayName, 'Disposable Tester');
  });

  await t.test('13. .env.local Write Safety — Overwrite Prevention', () => {
    const mockFs = {
      files: new Map([['.env.local', 'EXISTING_CONTENT']]),
      existsSync(p) {
        return this.files.has(p);
      },
      writeFileSync(p, content) {
        this.files.set(p, content);
      },
      chmodSync() {}
    };

    // Default overwrite = false must refuse to overwrite
    assert.throws(
      () => writeEnvLocalCredentials({
        authenticatedEmail: DISPOSABLE_EMAIL,
        accessToken: 'mock_token_123',
        envPath: '.env.local',
        overwrite: false,
        fsModule: mockFs
      }),
      /ENV_LOCAL_EXISTS_ABORT/,
      'Must refuse to overwrite existing .env.local without explicit authorization'
    );

    // Verify existing file content was untouched
    assert.equal(mockFs.files.get('.env.local'), 'EXISTING_CONTENT');
  });

  await t.test('14. .env.local Write Safety — Authorized Overwrite & Restrictive Permissions', () => {
    let capturedOptions = null;
    let capturedChmodMode = null;

    const mockFs = {
      files: new Map([['.env.local', 'OLD_CONTENT']]),
      existsSync(p) {
        return this.files.has(p);
      },
      writeFileSync(p, content, options) {
        capturedOptions = options;
        this.files.set(p, content);
      },
      chmodSync(p, mode) {
        capturedChmodMode = mode;
      }
    };

    const res = writeEnvLocalCredentials({
      authenticatedEmail: DISPOSABLE_EMAIL,
      accessToken: 'mock_access_token_super_secret',
      refreshToken: '1//mock_refresh_token_persistent',
      clientId: MOCK_CLIENT_ID,
      envPath: '.env.local',
      overwrite: true,
      fsModule: mockFs
    });

    assert.equal(res.success, true);
    assert.equal(capturedOptions.mode, 0o600, 'Must specify 0o600 permissions in writeFileSync');
    assert.equal(capturedChmodMode, 0o600, 'Must apply 0o600 chmod');

    const written = mockFs.files.get('.env.local');
    assert.ok(written.includes(`EXPECTED_DISPOSABLE_ACCOUNT=${DISPOSABLE_EMAIL}`));
    assert.ok(written.includes('DISPOSABLE_DRIVE_TOKEN=mock_access_token_super_secret'));
    assert.ok(written.includes('DISPOSABLE_DRIVE_REFRESH_TOKEN=1//mock_refresh_token_persistent'));
    assert.ok(written.includes(`GOOGLE_CLIENT_ID=${MOCK_CLIENT_ID}`));
    assert.ok(!written.includes('client_secret'), 'Must NOT write client secret to .env.local');
  });

  await t.test('14b. .env.local Preservation — Preserves existing refresh token when Google re-auth omits it', () => {
    const existingFileContent = [
      '# Existing finman env',
      `EXPECTED_DISPOSABLE_ACCOUNT=${DISPOSABLE_EMAIL}`,
      'DISPOSABLE_DRIVE_TOKEN=old_expired_access_token',
      'DISPOSABLE_DRIVE_REFRESH_TOKEN=1//existing_valid_refresh_token_xyz',
      `GOOGLE_CLIENT_ID=${MOCK_CLIENT_ID}`
    ].join('\n');

    const mockFs = {
      files: new Map([['.env.local', existingFileContent]]),
      existsSync(p) { return this.files.has(p); },
      readFileSync(p) { return this.files.get(p); },
      writeFileSync(p, content) { this.files.set(p, content); },
      chmodSync() {}
    };

    // Re-authenticating where Google returns a new access token, but NO refresh token (refreshToken: null)
    const res = writeEnvLocalCredentials({
      authenticatedEmail: DISPOSABLE_EMAIL,
      accessToken: 'new_fresh_access_token_123',
      refreshToken: null, // Google did not reissue refresh token
      envPath: '.env.local',
      overwrite: true,
      fsModule: mockFs
    });

    assert.equal(res.success, true);
    assert.equal(res.hasRefreshToken, true);

    const updated = mockFs.files.get('.env.local');
    assert.ok(updated.includes('DISPOSABLE_DRIVE_TOKEN=new_fresh_access_token_123'), 'Must update access token');
    assert.ok(updated.includes('DISPOSABLE_DRIVE_REFRESH_TOKEN=1//existing_valid_refresh_token_xyz'), 'Must preserve existing refresh token');
    assert.ok(updated.includes(`GOOGLE_CLIENT_ID=${MOCK_CLIENT_ID}`), 'Must preserve existing client ID');
  });

  await t.test('15. Secret Redaction — Tokens, codes, refresh tokens, and secrets redacted from logs and errors', () => {
    const rawError = new Error('Failed with Bearer ya29.a0AfH6SMDI8834_secret_token and code=4/0AbCdEf123 and client_secret=GOCSPX-super_secret and {"client_secret": "GOCSPX-json_secret"} and GOCSPX-raw_secret_leak and refresh_token=1//09876_refresh_secret and {"refresh_token": "1//json_refresh_secret"} and 1//0_raw_refresh_prefix');
    const sanitized = sanitizeErrorMessage(rawError);

    assert.ok(!sanitized.includes('ya29.a0AfH6SMDI8834_secret_token'), 'Must redact Bearer token');
    assert.ok(!sanitized.includes('4/0AbCdEf123'), 'Must redact authorization code');
    assert.ok(!sanitized.includes('GOCSPX-super_secret'), 'Must redact client secret in query');
    assert.ok(!sanitized.includes('GOCSPX-json_secret'), 'Must redact client secret in JSON');
    assert.ok(!sanitized.includes('GOCSPX-raw_secret_leak'), 'Must redact raw GOCSPX secret');
    assert.ok(!sanitized.includes('1//09876_refresh_secret'), 'Must redact refresh token in query');
    assert.ok(!sanitized.includes('1//json_refresh_secret'), 'Must redact refresh token in JSON');
    assert.ok(!sanitized.includes('1//0_raw_refresh_prefix'), 'Must redact raw 1// refresh token');
    assert.ok(sanitized.includes('Bearer [REDACTED]'), 'Must replace token with Bearer [REDACTED]');
    assert.ok(sanitized.includes('code=[REDACTED]'), 'Must replace code with code=[REDACTED]');
    assert.ok(sanitized.includes('client_secret=[REDACTED]'), 'Must replace client_secret with client_secret=[REDACTED]');
    assert.ok(sanitized.includes('client_secret: "[REDACTED]"'), 'Must replace JSON client_secret with redacted');
    assert.ok(sanitized.includes('refresh_token=[REDACTED]'), 'Must replace refresh_token query param with redacted');
    assert.ok(sanitized.includes('refresh_token: "[REDACTED]"'), 'Must replace JSON refresh_token with redacted');
  });

  await t.test('16. End-to-End Authentication Pipeline (Injected Mocks)', async () => {
    const mockFiles = new Map();
    const mockFs = {
      existsSync: (p) => mockFiles.has(p),
      writeFileSync: (p, c) => mockFiles.set(p, c),
      chmodSync: () => {}
    };

    let browserOpenedWithUrl = null;

    const mockOpenBrowser = async (url) => {
      browserOpenedWithUrl = url;
      // Extract state from auth URL and simulate immediate loopback callback
      const parsed = new URL(url);
      const state = parsed.searchParams.get('state');
      const redirectUri = parsed.searchParams.get('redirect_uri');

      setTimeout(async () => {
        try {
          const r = await fetch(`${redirectUri}?code=mock_auth_code_pipeline&state=${state}`);
          await r.text();
        } catch {}
      }, 20);

      return { opened: true };
    };

    const mockTokenExchange = async () => ({
      accessToken: 'mock_pipeline_token_777',
      expiresIn: 3600,
      tokenType: 'Bearer'
    });

    const mockFetchUserInfo = async () => ({
      emailAddress: DISPOSABLE_EMAIL,
      displayName: 'Pipeline Tester'
    });

    let promptCalled = false;
    const mockPrompt = async ({ maskedEmail }) => {
      promptCalled = true;
      assert.equal(maskedEmail, maskEmail(DISPOSABLE_EMAIL));
      return true; // Confirmed
    };

    const result = await runInteractiveAuthentication({
      clientId: MOCK_CLIENT_ID,
      expectedAccount: DISPOSABLE_EMAIL,
      port: 0,
      overwrite: false,
      envPath: '.env.local',
      openBrowserFn: mockOpenBrowser,
      tokenExchangeFn: mockTokenExchange,
      fetchUserInfoFn: mockFetchUserInfo,
      promptFn: mockPrompt,
      fsModule: mockFs
    });

    assert.equal(result.success, true);
    assert.equal(result.maskedEmail, maskEmail(DISPOSABLE_EMAIL));
    assert.equal(result.displayName, 'Pipeline Tester');
    assert.equal(promptCalled, true, 'User confirmation prompt must have been called');
    assert.ok(browserOpenedWithUrl, 'Browser open helper must have been called');

    // Confirm file written to mock fs
    const writtenFile = mockFiles.get('.env.local');
    assert.ok(writtenFile, 'Must write .env.local');
    assert.ok(writtenFile.includes(`EXPECTED_DISPOSABLE_ACCOUNT=${DISPOSABLE_EMAIL}`));
    assert.ok(writtenFile.includes('DISPOSABLE_DRIVE_TOKEN=mock_pipeline_token_777'));
  });

  await t.test('17. Desktop Client ID Validation — Rejects missing client ID without falling back to Web client ID', async () => {
    const savedGoogleClientId = process.env.GOOGLE_CLIENT_ID;
    const savedViteClientId = process.env.VITE_GOOGLE_CLIENT_ID;

    try {
      delete process.env.GOOGLE_CLIENT_ID;
      process.env.VITE_GOOGLE_CLIENT_ID = 'existing-web-client-id.apps.googleusercontent.com';

      // Calling runInteractiveAuthentication without clientId must reject with MISSING_DESKTOP_CLIENT_ID
      await assert.rejects(
        runInteractiveAuthentication({
          clientId: undefined,
          openBrowserFn: async () => ({ opened: true }),
          fsModule: { existsSync: () => false }
        }),
        /MISSING_DESKTOP_CLIENT_ID/,
        'Must reject missing Desktop client ID and strictly refuse to fall back to VITE_GOOGLE_CLIENT_ID'
      );

      // Rejects empty or whitespace-only client ID as well
      await assert.rejects(
        runInteractiveAuthentication({
          clientId: '   ',
          openBrowserFn: async () => ({ opened: true }),
          fsModule: { existsSync: () => false }
        }),
        /MISSING_DESKTOP_CLIENT_ID/,
        'Must reject whitespace-only Desktop client ID'
      );
    } finally {
      if (savedGoogleClientId !== undefined) {
        process.env.GOOGLE_CLIENT_ID = savedGoogleClientId;
      } else {
        delete process.env.GOOGLE_CLIENT_ID;
      }
      if (savedViteClientId !== undefined) {
        process.env.VITE_GOOGLE_CLIENT_ID = savedViteClientId;
      } else {
        delete process.env.VITE_GOOGLE_CLIENT_ID;
      }
    }
  });

  await t.test('18. Desktop Client ID Consistency — Uses supplied Desktop client ID identically in authorization and token exchange', async () => {
    const DESKTOP_CLIENT_ID = '999888777-desktop-client.apps.googleusercontent.com';

    let capturedAuthClientId = null;
    let capturedTokenClientId = null;
    let capturedTokenClientSecret = null;
    let capturedCodeVerifier = null;
    let capturedCodeChallenge = null;

    const mockOpenBrowser = async (url) => {
      const parsed = new URL(url);
      capturedAuthClientId = parsed.searchParams.get('client_id');
      capturedCodeChallenge = parsed.searchParams.get('code_challenge');
      const state = parsed.searchParams.get('state');
      const redirectUri = parsed.searchParams.get('redirect_uri');

      setTimeout(async () => {
        try {
          const r = await fetch(`${redirectUri}?code=desktop_test_code&state=${state}`);
          await r.text();
        } catch {}
      }, 20);

      return { opened: true };
    };

    const mockTokenExchange = async ({ clientId, clientSecret, codeVerifier }) => {
      capturedTokenClientId = clientId;
      capturedTokenClientSecret = clientSecret;
      capturedCodeVerifier = codeVerifier;
      return {
        accessToken: 'mock_desktop_token',
        expiresIn: 3600,
        tokenType: 'Bearer'
      };
    };

    const mockFetchUserInfo = async () => ({
      emailAddress: DISPOSABLE_EMAIL,
      displayName: 'Desktop Tester'
    });

    const mockFs = {
      files: new Map(),
      existsSync: () => false,
      writeFileSync(p, c) { this.files.set(p, c); },
      chmodSync: () => {}
    };

    await runInteractiveAuthentication({
      clientId: DESKTOP_CLIENT_ID,
      clientSecret: 'GOCSPX-supplied-secret',
      expectedAccount: DISPOSABLE_EMAIL,
      port: 0,
      envPath: '.env.local.mock',
      openBrowserFn: mockOpenBrowser,
      tokenExchangeFn: mockTokenExchange,
      fetchUserInfoFn: mockFetchUserInfo,
      promptFn: async () => true,
      fsModule: mockFs
    });

    assert.equal(capturedAuthClientId, DESKTOP_CLIENT_ID, 'Authorization URL must use supplied Desktop client ID');
    assert.equal(capturedTokenClientId, DESKTOP_CLIENT_ID, 'Token exchange must use identical Desktop client ID');
    assert.equal(capturedTokenClientSecret, 'GOCSPX-supplied-secret', 'Token exchange must receive supplied client secret');

    // Confirm PKCE code_verifier matches code_challenge
    const expectedChallenge = crypto
      .createHash('sha256')
      .update(capturedCodeVerifier)
      .digest('base64url');
    assert.equal(expectedChallenge, capturedCodeChallenge, 'PKCE verifier in token exchange must match challenge in authorization URL');
  });

});
