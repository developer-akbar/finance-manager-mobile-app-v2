/**
 * googleDriveSync.js — Google Drive REST API v3 Client for appDataFolder
 * 
 * Manages private, sandboxed application files inside the user's Google Drive appDataFolder.
 * Uses direct CORS fetch calls to Google Drive REST API endpoints.
 * Scope: https://www.googleapis.com/auth/drive.appdata
 */

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

/**
 * Find a file by name inside appDataFolder
 */
export async function findAppDataFile(filename, accessToken) {
  if (!accessToken) throw new Error('Missing Google access token.');
  
  const query = encodeURIComponent(`name = '${filename}' and trashed = false`);
  const url = `${DRIVE_API_BASE}/files?spaces=appDataFolder&q=${query}&fields=files(id,name,modifiedTime,size,version)&pageSize=1`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google Drive API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return (data.files && data.files.length > 0) ? data.files[0] : null;
}

/**
 * Read the full content of a file from Google Drive by File ID
 */
export async function readAppDataFile(fileId, accessToken) {
  if (!accessToken) throw new Error('Missing Google access token.');
  if (!fileId) throw new Error('Missing File ID.');

  const url = `${DRIVE_API_BASE}/files/${fileId}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to read file from Drive (${res.status}): ${errText}`);
  }

  return await res.text();
}

/**
 * Upload or update a file in appDataFolder using standard multipart upload
 */
export async function uploadAppDataFile(filename, content, mimeType = 'application/json', accessToken) {
  if (!accessToken) throw new Error('Missing Google access token.');

  // Check if file already exists in appDataFolder
  const existingFile = await findAppDataFile(filename, accessToken);
  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadata = existingFile
    ? { name: filename, mimeType }
    : { name: filename, mimeType, parents: ['appDataFolder'] };

  const multipartRequestBody =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    `Content-Type: ${mimeType}\r\n\r\n` +
    content +
    closeDelimiter;

  const url = existingFile
    ? `${DRIVE_UPLOAD_BASE}/files/${existingFile.id}?uploadType=multipart`
    : `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart`;

  const method = existingFile ? 'PATCH' : 'POST';

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: multipartRequestBody
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to upload file to Drive (${res.status}): ${errText}`);
  }

  return await res.json();
}

/**
 * Delete a file from appDataFolder
 */
export async function deleteAppDataFile(fileId, accessToken) {
  if (!accessToken || !fileId) return;

  const url = `${DRIVE_API_BASE}/files/${fileId}`;
  await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
}

/**
 * List all files in appDataFolder (for diagnostics/debugging)
 */
export async function listAppDataFiles(accessToken) {
  if (!accessToken) return [];

  const url = `${DRIVE_API_BASE}/files?spaces=appDataFolder&fields=files(id,name,modifiedTime,size)&pageSize=50`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.files || [];
}

/**
 * Perform an end-to-end transport verification test using a synthetic, encrypted payload.
 * NEVER uploads real financial records.
 * Tests: Upload -> Read -> Decrypt verify -> Update -> Read verify -> Delete -> Confirm Deleted.
 */
export async function testDriveTransport(accessToken, testPin = '1234') {
  if (!accessToken) throw new Error('Missing Google access token.');
  if (!testPin) throw new Error('Test PIN is required for client-side encryption.');

  const TEST_FILENAME = 'finman_transport_test.finman';
  const testId = 'test-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
  
  const syntheticPayload = {
    type: 'finman-cloud-sync-test',
    version: 1,
    createdAt: new Date().toISOString(),
    randomTestId: testId,
    message: 'FinMan Drive transport test'
  };

  const { encryptBackupData, decryptBackupData } = await import('../utils/cryptoBackup.js');

  // 1. Encrypt synthetic payload
  const encryptedText = await encryptBackupData(syntheticPayload, testPin);

  // 2. Upload to appDataFolder
  const uploadResult = await uploadAppDataFile(TEST_FILENAME, encryptedText, 'application/octet-stream', accessToken);
  const fileId = uploadResult.id;

  // 3. Read back
  const readBackText = await readAppDataFile(fileId, accessToken);

  // 4. Decrypt and verify exact match
  const decryptedPayload = await decryptBackupData(readBackText, testPin);
  if (!decryptedPayload || decryptedPayload.randomTestId !== testId) {
    throw new Error('Transport test failed: Decrypted payload did not match uploaded synthetic test data.');
  }

  // 5. Update test file with modified timestamp
  syntheticPayload.updatedAt = new Date().toISOString();
  const updatedEncryptedText = await encryptBackupData(syntheticPayload, testPin);
  await uploadAppDataFile(TEST_FILENAME, updatedEncryptedText, 'application/octet-stream', accessToken);

  // 6. Read and verify update
  const updatedReadText = await readAppDataFile(fileId, accessToken);
  const updatedDecrypted = await decryptBackupData(updatedReadText, testPin);
  if (!updatedDecrypted || !updatedDecrypted.updatedAt) {
    throw new Error('Transport test failed: Updated payload verification failed.');
  }

  // 7. Delete the test file
  await deleteAppDataFile(fileId, accessToken);

  // 8. Confirm test file no longer exists
  const existingAfterDelete = await findAppDataFile(TEST_FILENAME, accessToken);
  if (existingAfterDelete) {
    throw new Error('Transport test failed: Test file still exists after deletion.');
  }

  return {
    success: true,
    testId,
    verifiedRoundTrip: true,
    fileDeleted: true,
    timestamp: new Date().toISOString()
  };
}
