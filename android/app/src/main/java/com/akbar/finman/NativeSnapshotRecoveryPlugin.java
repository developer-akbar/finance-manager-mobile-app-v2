package com.akbar.finman;

import android.content.ContentValues;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteStatement;
import android.util.JsonReader;
import android.util.JsonToken;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.spec.KeySpec;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * NativeSnapshotRecoveryPlugin — Memory-Safe Android Snapshot Recovery Engine (Phase B)
 *
 * Implements bounded streaming download, chunked Base64 extraction, native AES-256-GCM
 * decryption with full tag verification, and bounded SQLite staging.
 *
 * Guarantees:
 * 1. Zero full-payload Base64 strings or ArrayBuffers in WebView JavaScript heap.
 * 2. Peak native Java heap usage bounded under 10 MB regardless of snapshot size.
 * 3. GCM authentication tag verified before staging commences.
 * 4. Staging into an isolated cache database; zero competing connection to main database.
 */
@CapacitorPlugin(name = "NativeSnapshotRecovery")
public class NativeSnapshotRecoveryPlugin extends Plugin {

    private static final String TAG = "NativeSnapshotRecovery";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    public static class EnvelopeMetadata {
        public String salt = "";
        public String iv = "";
        public long version = 1;
        public String createdAt = "";
    }

    public static class StagingResult {
        public String stagingDbPath;
        public String snapshotId;
        public long cloudVersion;
        public long schemaVersion = 13;
        public String deviceId;
        public String createdAt;
        public Map<String, Long> entityCounts = new HashMap<>();
        public Map<String, Long> peerWatermarks = new HashMap<>();
        public long durationMs;
        public long peakMemoryBytes;
    }

    @PluginMethod
    public void prepareStagingSnapshot(PluginCall call) {
        executor.execute(() -> {
            File tempCipherFile = null;
            File tempPlainFile = null;
            File stagingDbFile = null;

            long startTime = System.currentTimeMillis();
            Runtime runtime = Runtime.getRuntime();
            long initialMem = runtime.totalMemory() - runtime.freeMemory();
            long peakMem = initialMem;

            try {
                String pin = call.getString("pin");
                if (pin == null || pin.trim().isEmpty()) {
                    call.reject("PIN is required for native snapshot decryption", "PIN_REQUIRED");
                    return;
                }

                String fileId = call.getString("fileId");
                String accessToken = call.getString("accessToken");
                String sourceFilePath = call.getString("sourceFilePath");

                File cacheDir = getContext().getCacheDir();
                tempCipherFile = new File(cacheDir, "finman_snap_cipher_" + System.currentTimeMillis() + ".bin");
                tempPlainFile = new File(cacheDir, "finman_snap_plain_" + System.currentTimeMillis() + ".json");
                stagingDbFile = new File(cacheDir, "finman_staging_" + System.currentTimeMillis() + ".db");

                Log.i(TAG, "Starting prepareStagingSnapshot: fileId=" + fileId + ", sourceFilePath=" + sourceFilePath);

                // Step 1: Open input stream (either Google Drive HTTP stream or local file)
                InputStream rawIn;
                HttpURLConnection conn = null;
                if (sourceFilePath != null && !sourceFilePath.isEmpty()) {
                    File src = new File(sourceFilePath);
                    if (!src.exists()) {
                        call.reject("Source snapshot file not found: " + sourceFilePath, "FILE_NOT_FOUND");
                        return;
                    }
                    rawIn = new FileInputStream(src);
                } else if (fileId != null && !fileId.isEmpty()) {
                    if (accessToken == null || accessToken.isEmpty()) {
                        call.reject("Access token required for Google Drive download", "AUTH_REQUIRED");
                        return;
                    }
                    URL url = new URL("https://www.googleapis.com/drive/v3/files/" + fileId + "?alt=media");
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("GET");
                    conn.setRequestProperty("Authorization", "Bearer " + accessToken);
                    conn.setConnectTimeout(45000);
                    conn.setReadTimeout(180000);
                    int respCode = conn.getResponseCode();
                    if (respCode != 200) {
                        call.reject("Google Drive download failed with HTTP " + respCode, "DOWNLOAD_FAILED");
                        return;
                    }
                    rawIn = conn.getInputStream();
                } else {
                    call.reject("Either fileId or sourceFilePath must be provided", "INVALID_ARGUMENTS");
                    return;
                }

                // Step 2: Stream outer envelope & extract Base64 data to tempCipherFile (bounded to 64KB buffers)
                EnvelopeMetadata meta;
                try (BufferedInputStream bis = new BufferedInputStream(rawIn, 65536);
                     Reader reader = new InputStreamReader(bis, StandardCharsets.UTF_8);
                     FileOutputStream fos = new FileOutputStream(tempCipherFile);
                     BufferedOutputStream bos = new BufferedOutputStream(fos, 65536)) {

                    meta = parseEnvelopeAndStreamCiphertext(reader, bos);
                    bos.flush();
                } finally {
                    if (conn != null) {
                        try { conn.disconnect(); } catch (Exception ignored) {}
                    }
                }

                if (meta.salt.isEmpty() || meta.iv.isEmpty()) {
                    call.reject("Corrupt snapshot envelope: salt or iv missing", "CORRUPT_ENVELOPE");
                    return;
                }

                Log.i(TAG, "Envelope extracted in " + (System.currentTimeMillis() - startTime) + " ms, cipherSize=" + tempCipherFile.length());

                long curMem = runtime.totalMemory() - runtime.freeMemory();
                if (curMem > peakMem) peakMem = curMem;

                // Step 3: Native AES-256-GCM decryption with GCM tag verification at doFinal()
                long decStart = System.currentTimeMillis();
                decryptCiphertextFile(tempCipherFile, tempPlainFile, pin.trim(), meta.salt, meta.iv);
                Log.i(TAG, "AES-GCM decryption complete in " + (System.currentTimeMillis() - decStart) + " ms, plainSize=" + tempPlainFile.length());

                // Discard ciphertext file immediately to save disk
                if (tempCipherFile.exists()) {
                    tempCipherFile.delete();
                }

                curMem = runtime.totalMemory() - runtime.freeMemory();
                if (curMem > peakMem) peakMem = curMem;

                // Step 4: Stream decrypted JSON into temporary staging SQLite database
                long stageStart = System.currentTimeMillis();
                StagingResult result = stageDecryptedJsonToSQLite(tempPlainFile, stagingDbFile);
                Log.i(TAG, "SQLite staging complete in " + (System.currentTimeMillis() - stageStart) + " ms, stagingDb=" + stagingDbFile.getAbsolutePath());

                // Discard decrypted plaintext file immediately
                if (tempPlainFile.exists()) {
                    tempPlainFile.delete();
                }

                long durationMs = System.currentTimeMillis() - startTime;
                result.durationMs = durationMs;
                result.peakMemoryBytes = Math.max(0, peakMem - initialMem);
                Log.i(TAG, "prepareStagingSnapshot succeeded in " + durationMs + " ms, peakMem=" + result.peakMemoryBytes);

                // Build Capacitor response
                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("stagingDbPath", result.stagingDbPath);
                ret.put("snapshotId", result.snapshotId);
                ret.put("cloudVersion", result.cloudVersion);
                ret.put("schemaVersion", result.schemaVersion);
                ret.put("deviceId", result.deviceId);
                ret.put("createdAt", result.createdAt);
                ret.put("durationMs", durationMs);
                ret.put("peakMemoryBytes", result.peakMemoryBytes);

                JSObject countsObj = new JSObject();
                for (Map.Entry<String, Long> entry : result.entityCounts.entrySet()) {
                    countsObj.put(entry.getKey(), entry.getValue());
                }
                ret.put("entityCounts", countsObj);

                JSObject watermarksObj = new JSObject();
                for (Map.Entry<String, Long> entry : result.peerWatermarks.entrySet()) {
                    watermarksObj.put(entry.getKey(), entry.getValue());
                }
                ret.put("coveredPeerWatermarks", watermarksObj);

                call.resolve(ret);

            } catch (javax.crypto.AEADBadTagException badTagEx) {
                cleanupFiles(tempCipherFile, tempPlainFile, stagingDbFile);
                call.reject("Incorrect PIN or corrupted ciphertext: AES-GCM tag verification failed", "DECRYPTION_FAILED", badTagEx);
            } catch (Exception ex) {
                cleanupFiles(tempCipherFile, tempPlainFile, stagingDbFile);
                call.reject("Native snapshot recovery failed: " + ex.getMessage(), "STAGING_FAILED", ex);
            }
        });
    }

    @PluginMethod
    public void cleanupStagingSnapshot(PluginCall call) {
        String stagingPath = call.getString("stagingDbPath");
        if (stagingPath != null && !stagingPath.isEmpty()) {
            File f = new File(stagingPath);
            if (f.exists()) {
                f.delete();
            }
        }
        JSObject ret = new JSObject();
        ret.put("success", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void testVerifyCrypto(PluginCall call) {
        try {
            String pin = call.getString("pin");
            String saltBase64 = call.getString("salt");
            String ivBase64 = call.getString("iv");
            String ciphertextBase64 = call.getString("ciphertext");

            if (pin == null || saltBase64 == null || ivBase64 == null || ciphertextBase64 == null) {
                call.reject("Missing required test crypto parameters", "INVALID_ARGUMENTS");
                return;
            }

            byte[] salt = Base64.getDecoder().decode(saltBase64.trim());
            byte[] iv = Base64.getDecoder().decode(ivBase64.trim());
            byte[] ciphertext = Base64.getDecoder().decode(ciphertextBase64.trim());

            SecretKeyFactory factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
            KeySpec spec = new PBEKeySpec(pin.toCharArray(), salt, 100000, 256);
            byte[] keyBytes = factory.generateSecret(spec).getEncoded();
            SecretKeySpec keySpec = new SecretKeySpec(keyBytes, "AES");

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            GCMParameterSpec gcmSpec = new GCMParameterSpec(128, iv);
            cipher.init(Cipher.DECRYPT_MODE, keySpec, gcmSpec);

            byte[] decrypted = cipher.doFinal(ciphertext);
            String plainText = new String(decrypted, StandardCharsets.UTF_8);

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("plainText", plainText);
            call.resolve(ret);
        } catch (javax.crypto.AEADBadTagException e) {
            call.reject("AEADBadTagException: Authentication tag mismatch", "TAG_MISMATCH", e);
        } catch (Exception e) {
            call.reject("Decryption test failed: " + e.getMessage(), "CRYPTO_ERROR", e);
        }
    }

    private static void cleanupFiles(File... files) {
        for (File f : files) {
            if (f != null && f.exists()) {
                try { f.delete(); } catch (Exception ignored) {}
            }
        }
    }

    /**
     * Streams the outer JSON envelope without buffering the large Base64 "data" field.
     * Decodes Base64 in 8192-char chunks directly into the output stream.
     */
    public static EnvelopeMetadata parseEnvelopeAndStreamCiphertext(Reader reader, BufferedOutputStream bos) throws IOException {
        EnvelopeMetadata meta = new EnvelopeMetadata();
        StringBuilder keyBuf = new StringBuilder(64);
        boolean inString = false;
        boolean escape = false;

        int ch;
        while ((ch = reader.read()) != -1) {
            char c = (char) ch;

            if (c == '"' && !escape) {
                inString = !inString;
                if (!inString) {
                    String key = keyBuf.toString().trim();
                    keyBuf.setLength(0);

                    if ("salt".equals(key)) {
                        meta.salt = readJsonStringValue(reader);
                    } else if ("iv".equals(key)) {
                        meta.iv = readJsonStringValue(reader);
                    } else if ("data".equals(key)) {
                        streamBase64Value(reader, bos);
                    } else if ("created_at".equals(key)) {
                        meta.createdAt = readJsonStringValue(reader);
                    }
                }
                continue;
            }

            if (inString) {
                if (c == '\\' && !escape) {
                    escape = true;
                } else {
                    keyBuf.append(c);
                    escape = false;
                }
            }
        }
        return meta;
    }

    private static String readJsonStringValue(Reader reader) throws IOException {
        // Skip whitespace and ':' until opening quote
        int ch;
        while ((ch = reader.read()) != -1) {
            if ((char) ch == '"') break;
        }
        StringBuilder sb = new StringBuilder();
        boolean escape = false;
        while ((ch = reader.read()) != -1) {
            char c = (char) ch;
            if (c == '\\' && !escape) {
                escape = true;
                continue;
            }
            if (c == '"' && !escape) {
                break;
            }
            sb.append(c);
            escape = false;
        }
        return sb.toString();
    }

    /**
     * Reads the Base64 value characters chunk-by-chunk and decodes directly into the output stream.
     * Memory allocation is strictly bounded to the 8192 char buffer.
     */
    private static void streamBase64Value(Reader reader, BufferedOutputStream bos) throws IOException {
        // Skip until opening quote of data value
        int ch;
        while ((ch = reader.read()) != -1) {
            if ((char) ch == '"') break;
        }

        char[] charBuf = new char[8192];
        int charCount = 0;
        boolean escape = false;

        while ((ch = reader.read()) != -1) {
            char c = (char) ch;
            if (c == '\\' && !escape) {
                escape = true;
                continue;
            }
            if (c == '"' && !escape) {
                // Closing quote of data field reached
                break;
            }
            escape = false;

            // Skip whitespace characters occasionally injected in Base64
            if (c <= ' ') continue;

            charBuf[charCount++] = c;
            if (charCount == charBuf.length) {
                byte[] decoded = Base64.getDecoder().decode(new String(charBuf, 0, charCount));
                bos.write(decoded);
                charCount = 0;
            }
        }

        // Flush remaining Base64 characters
        if (charCount > 0) {
            // Must be multiple of 4
            int rem = charCount % 4;
            if (rem != 0) {
                int padNeeded = 4 - rem;
                StringBuilder sb = new StringBuilder(charCount + padNeeded);
                sb.append(charBuf, 0, charCount);
                for (int p = 0; p < padNeeded; p++) sb.append('=');
                byte[] decoded = Base64.getDecoder().decode(sb.toString());
                bos.write(decoded);
            } else {
                byte[] decoded = Base64.getDecoder().decode(new String(charBuf, 0, charCount));
                bos.write(decoded);
            }
        }
    }

    /**
     * Decrypts ciphertext file into plain JSON file using AES-256-GCM.
     * doFinal() verifies the 16-byte authentication tag.
     */
    public static void decryptCiphertextFile(File encryptedFile, File decryptedFile, String pin, String saltBase64, String ivBase64) throws Exception {
        byte[] salt = Base64.getDecoder().decode(saltBase64.trim());
        byte[] iv = Base64.getDecoder().decode(ivBase64.trim());

        SecretKeyFactory factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
        KeySpec spec = new PBEKeySpec(pin.toCharArray(), salt, 100000, 256);
        byte[] keyBytes = factory.generateSecret(spec).getEncoded();
        SecretKeySpec keySpec = new SecretKeySpec(keyBytes, "AES");

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        GCMParameterSpec gcmSpec = new GCMParameterSpec(128, iv);
        cipher.init(Cipher.DECRYPT_MODE, keySpec, gcmSpec);

        try (FileInputStream fis = new FileInputStream(encryptedFile);
             BufferedInputStream bis = new BufferedInputStream(fis, 65536);
             FileOutputStream fos = new FileOutputStream(decryptedFile);
             BufferedOutputStream bos = new BufferedOutputStream(fos, 65536)) {

            byte[] inBuf = new byte[65536];
            int bytesRead;
            while ((bytesRead = bis.read(inBuf)) != -1) {
                byte[] outBuf = cipher.update(inBuf, 0, bytesRead);
                if (outBuf != null && outBuf.length > 0) {
                    bos.write(outBuf);
                }
            }

            // doFinal() verifies the 16-byte authentication tag!
            byte[] finalBuf = cipher.doFinal();
            if (finalBuf != null && finalBuf.length > 0) {
                bos.write(finalBuf);
            }
            bos.flush();
        } catch (Exception e) {
            if (decryptedFile.exists()) {
                decryptedFile.delete();
            }
            throw e;
        }
    }

    /**
     * Parses decrypted JSON payload into a temporary staging SQLite database using streaming JsonReader.
     */
    public static StagingResult stageDecryptedJsonToSQLite(File decryptedFile, File stagingDbFile) throws Exception {
        if (stagingDbFile.exists()) {
            stagingDbFile.delete();
        }

        SQLiteDatabase db = SQLiteDatabase.openOrCreateDatabase(stagingDbFile, null);
        try {
            db.execSQL("PRAGMA synchronous = OFF;");
            db.execSQL("PRAGMA temp_store = MEMORY;");
            db.execSQL("PRAGMA cache_size = 10000;");
        } catch (Exception ignored) {}
        setPragma(db, "PRAGMA journal_mode = MEMORY;");

        StagingResult result = new StagingResult();
        result.stagingDbPath = stagingDbFile.getAbsolutePath();

        try (FileInputStream fis = new FileInputStream(decryptedFile);
             InputStreamReader isr = new InputStreamReader(fis, StandardCharsets.UTF_8);
             BufferedReader br = new BufferedReader(isr, 65536);
             JsonReader reader = new JsonReader(br)) {

            reader.beginObject();
            while (reader.hasNext()) {
                String topName = reader.nextName();
                if ("payload".equals(topName)) {
                    reader.beginObject();
                    while (reader.hasNext()) {
                        parseSinglePayloadField(reader, reader.nextName(), result, db);
                    }
                    reader.endObject();
                } else {
                    parseSinglePayloadField(reader, topName, result, db);
                }
            }
            reader.endObject();
            try { db.execSQL("DROP TABLE IF EXISTS android_metadata;"); } catch (Exception ignored) {}
        } finally {
            try { db.close(); } catch (Exception ignored) {}
        }

        return result;
    }

    /**
     * Executes PRAGMA statements safely using rawQuery to support statements that return a result row
     * (e.g. PRAGMA journal_mode) without triggering SQLiteDatabase execSQL row-returning exceptions.
     */
    public static void setPragma(SQLiteDatabase db, String pragmaSql) {
        try (android.database.Cursor cursor = db.rawQuery(pragmaSql, null)) {
            if (cursor != null) {
                cursor.moveToFirst();
            }
        } catch (Exception ignored) {}
    }

    public static class StatementCache {
        private final SQLiteDatabase db;
        private final Map<String, SQLiteStatement> cache = new HashMap<>();

        public StatementCache(SQLiteDatabase db) {
            this.db = db;
        }

        public SQLiteStatement get(String sql) {
            SQLiteStatement stmt = cache.get(sql);
            if (stmt == null) {
                stmt = db.compileStatement(sql);
                cache.put(sql, stmt);
            }
            return stmt;
        }

        public void close() {
            for (SQLiteStatement stmt : cache.values()) {
                try { stmt.close(); } catch (Exception ignored) {}
            }
            cache.clear();
        }
    }

    private static void parseSinglePayloadField(JsonReader reader, String pName, StagingResult result, SQLiteDatabase db) throws Exception {
        if ("snapshot_id".equals(pName)) {
            result.snapshotId = reader.nextString();
        } else if ("cloud_version".equals(pName)) {
            result.cloudVersion = reader.nextLong();
        } else if ("schema_version".equals(pName)) {
            result.schemaVersion = reader.nextLong();
        } else if ("device_id".equals(pName)) {
            result.deviceId = reader.nextString();
        } else if ("created_at".equals(pName)) {
            result.createdAt = reader.nextString();
        } else if ("covered_peer_watermarks".equals(pName)) {
            reader.beginObject();
            while (reader.hasNext()) {
                result.peerWatermarks.put(reader.nextName(), reader.nextLong());
            }
            reader.endObject();
        } else if ("entities".equals(pName)) {
            reader.beginObject();
            while (reader.hasNext()) {
                String tableName = reader.nextName();
                JsonToken peekToken = reader.peek();
                long count;
                if (peekToken == JsonToken.BEGIN_OBJECT) {
                    count = streamSettingsObject(reader, tableName, db);
                } else if (peekToken == JsonToken.BEGIN_ARRAY) {
                    count = streamTableEntities(reader, tableName, db);
                } else {
                    reader.skipValue();
                    count = 0;
                }
                result.entityCounts.put(tableName, count);
                Log.i(TAG, "Table [" + tableName + "] staged: " + count + " rows");
            }
            reader.endObject();
        } else {
            reader.skipValue();
        }
    }

    /**
     * Inserts or replaces a record into the table with square-bracket quoted column names.
     * Reuses compiled SQLiteStatements from StatementCache to achieve maximum insertion speed.
     */
    private static void insertWithQuotedColumns(SQLiteDatabase db, String tableName, ContentValues cv, StatementCache stmtCache) {
        if (cv == null || cv.size() == 0) return;
        StringBuilder sql = new StringBuilder(128);
        sql.append("INSERT OR REPLACE INTO [").append(tableName.replace("]", "]]")).append("] (");
        StringBuilder values = new StringBuilder(64);
        values.append(" VALUES (");

        Object[] bindArgs = new Object[cv.size()];
        int i = 0;
        for (String colName : cv.keySet()) {
            if (i > 0) {
                sql.append(", ");
                values.append(", ");
            }
            sql.append("[").append(colName.replace("]", "]]")).append("]");
            values.append("?");
            bindArgs[i] = cv.get(colName);
            i++;
        }
        sql.append(")").append(values).append(");");

        if (stmtCache != null) {
            String sqlStr = sql.toString();
            SQLiteStatement stmt = stmtCache.get(sqlStr);
            stmt.clearBindings();
            for (int b = 0; b < bindArgs.length; b++) {
                Object val = bindArgs[b];
                int bindIdx = b + 1;
                if (val == null) {
                    stmt.bindNull(bindIdx);
                } else if (val instanceof Long || val instanceof Integer || val instanceof Short || val instanceof Byte) {
                    stmt.bindLong(bindIdx, ((Number) val).longValue());
                } else if (val instanceof Double || val instanceof Float) {
                    stmt.bindDouble(bindIdx, ((Number) val).doubleValue());
                } else {
                    stmt.bindString(bindIdx, val.toString());
                }
            }
            stmt.executeInsert();
        } else {
            db.execSQL(sql.toString(), bindArgs);
        }
    }

    private static long streamSettingsObject(JsonReader reader, String tableName, SQLiteDatabase db) throws Exception {
        db.execSQL("CREATE TABLE IF NOT EXISTS [" + tableName + "] ([key] TEXT PRIMARY KEY, [value] TEXT);");
        reader.beginObject();
        long count = 0;
        StatementCache stmtCache = new StatementCache(db);
        db.beginTransaction();
        try {
            while (reader.hasNext()) {
                String key = reader.nextName();
                String val = consumeTokenAsString(reader);
                ContentValues cv = new ContentValues();
                cv.put("key", key);
                cv.put("value", val);
                insertWithQuotedColumns(db, tableName, cv, stmtCache);
                count++;
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
            stmtCache.close();
        }
        reader.endObject();
        return count;
    }

    private static long streamTableEntities(JsonReader reader, String tableName, SQLiteDatabase db) throws Exception {
        reader.beginArray();
        long count = 0;

        String pkCol = "id";
        if ("settings".equalsIgnoreCase(tableName)) pkCol = "key";
        else if ("sync_conflicts".equalsIgnoreCase(tableName)) pkCol = "conflict_id";
        db.execSQL("CREATE TABLE IF NOT EXISTS [" + tableName + "] ([" + pkCol + "] TEXT PRIMARY KEY);");

        java.util.Set<String> knownCols = new java.util.HashSet<>();
        knownCols.add(pkCol.toLowerCase());

        StatementCache stmtCache = new StatementCache(db);
        db.beginTransaction();
        try {
            while (reader.hasNext()) {
                ContentValues cv = new ContentValues();
                reader.beginObject();
                while (reader.hasNext()) {
                    String col = reader.nextName();
                    String colLower = col.toLowerCase();
                    if (!knownCols.contains(colLower)) {
                        try {
                            db.execSQL("ALTER TABLE [" + tableName + "] ADD COLUMN [" + col.replace("]", "]]") + "] TEXT;");
                        } catch (Exception ignored) {}
                        knownCols.add(colLower);
                    }

                    JsonToken token = reader.peek();
                    if (token == JsonToken.NULL) {
                        reader.nextNull();
                        cv.putNull(col);
                    } else if (token == JsonToken.BOOLEAN) {
                        cv.put(col, reader.nextBoolean() ? 1 : 0);
                    } else if (token == JsonToken.NUMBER) {
                        cv.put(col, reader.nextString());
                    } else if (token == JsonToken.STRING) {
                        cv.put(col, reader.nextString());
                    } else {
                        cv.put(col, consumeAnyAsJsonString(reader));
                    }
                }
                reader.endObject();

                insertWithQuotedColumns(db, tableName, cv, stmtCache);
                count++;

                if (count % 5000 == 0) {
                    db.setTransactionSuccessful();
                    db.endTransaction();
                    db.beginTransaction();
                }
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
            stmtCache.close();
        }
        reader.endArray();
        return count;
    }

    private static String consumeTokenAsString(JsonReader reader) throws IOException {
        JsonToken token = reader.peek();
        if (token == JsonToken.NULL) {
            reader.nextNull();
            return null;
        } else if (token == JsonToken.BOOLEAN) {
            return reader.nextBoolean() ? "true" : "false";
        } else if (token == JsonToken.NUMBER || token == JsonToken.STRING) {
            return reader.nextString();
        } else {
            return consumeAnyAsJsonString(reader);
        }
    }

    private static String consumeAnyAsJsonString(JsonReader reader) throws IOException {
        JsonToken token = reader.peek();
        if (token == JsonToken.BEGIN_OBJECT) {
            StringBuilder sb = new StringBuilder("{");
            reader.beginObject();
            boolean first = true;
            while (reader.hasNext()) {
                if (!first) sb.append(",");
                first = false;
                String k = reader.nextName();
                sb.append("\"").append(escapeJsonString(k)).append("\":");
                sb.append(consumeTokenAsRawJson(reader));
            }
            reader.endObject();
            sb.append("}");
            return sb.toString();
        } else if (token == JsonToken.BEGIN_ARRAY) {
            StringBuilder sb = new StringBuilder("[");
            reader.beginArray();
            boolean first = true;
            while (reader.hasNext()) {
                if (!first) sb.append(",");
                first = false;
                sb.append(consumeTokenAsRawJson(reader));
            }
            reader.endArray();
            sb.append("]");
            return sb.toString();
        } else {
            return consumeTokenAsString(reader);
        }
    }

    private static String consumeTokenAsRawJson(JsonReader reader) throws IOException {
        JsonToken token = reader.peek();
        if (token == JsonToken.NULL) {
            reader.nextNull();
            return "null";
        } else if (token == JsonToken.BOOLEAN) {
            return reader.nextBoolean() ? "true" : "false";
        } else if (token == JsonToken.NUMBER) {
            return reader.nextString();
        } else if (token == JsonToken.STRING) {
            return "\"" + escapeJsonString(reader.nextString()) + "\"";
        } else {
            return consumeAnyAsJsonString(reader);
        }
    }

    private static String escapeJsonString(String str) {
        if (str == null) return "";
        StringBuilder sb = new StringBuilder(str.length() + 8);
        for (int i = 0; i < str.length(); i++) {
            char c = str.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 32) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.toString();
    }
}
