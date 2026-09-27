/**
 * canonical_fingerprint.test.js — Phase 7.1 Canonical Entity & SHA-256 Verification
 * 
 * Verifies RFC 8785 / JCS canonicalization, numeric normalization, Unicode normalization,
 * ephemeral key stripping, and deterministic cross-platform SHA-256 fingerprinting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICALIZATION_VERSION,
  canonicalizeValue,
  toCanonicalJson,
  computeCanonicalSha256
} from '../utils/canonicalEntity.js';

test('FinMan Phase 7.1 — Canonical Entity & Fingerprint Test Suite', async (t) => {

  await t.test('1. Object key ordering — different key insertion orders produce identical canonical JSON and SHA-256', async () => {
    const objA = { z: 100, a: 'test', m: true, b: { y: 2, x: 1 } };
    const objB = { b: { x: 1, y: 2 }, a: 'test', z: 100, m: true };

    const jsonA = toCanonicalJson(objA);
    const jsonB = toCanonicalJson(objB);

    assert.equal(jsonA, jsonB);
    assert.equal(jsonA, '{"a":"test","b":{"x":1,"y":2},"m":true,"z":100}');

    const hashA = await computeCanonicalSha256(objA);
    const hashB = await computeCanonicalSha256(objB);

    assert.equal(hashA, hashB);
    assert.match(hashA, /^[0-9a-f]{64}$/);
  });

  await t.test('2. Ephemeral fields stripping — UI and alias keys are ignored in fingerprint computation', async () => {
    const cleanEntity = {
      id: 'txn_123',
      account: 'HDFC',
      inr: 500,
      note: 'Dinner'
    };

    const dirtyEntity = {
      id: 'txn_123',
      _id: 'txn_123',
      ID: 'txn_123',
      account: 'HDFC',
      inr: 500,
      note: 'Dinner',
      _ui_selected: true,
      _expanded: false,
      _cached_display: 'Formatted Text',
      _temp_id: 'tmp_99'
    };

    const hashClean = await computeCanonicalSha256(cleanEntity);
    const hashDirty = await computeCanonicalSha256(dirtyEntity);

    assert.equal(hashClean, hashDirty);
    assert.equal(toCanonicalJson(dirtyEntity), '{"account":"HDFC","id":"txn_123","inr":500,"note":"Dinner"}');
  });

  await t.test('3. Monetary values normalization — 2 decimal places rounding and negative zero cleanup', async () => {
    const entity1 = { inr: 120.504, actual_amount: 100.1, total_charges: -0 };
    const entity2 = { inr: 120.50, actual_amount: 100.10, total_charges: 0 };

    const json1 = toCanonicalJson(entity1);
    const json2 = toCanonicalJson(entity2);

    assert.equal(json1, json2);
    assert.equal(json1, '{"actual_amount":100.1,"inr":120.5,"total_charges":0}');

    const hash1 = await computeCanonicalSha256(entity1);
    const hash2 = await computeCanonicalSha256(entity2);
    assert.equal(hash1, hash2);
  });

  await t.test('4. Quantity normalization — 6 decimal places rounding', async () => {
    const stockA = { quantity: 12.3456789, unit_price: 100.5555554 };
    const stockB = { quantity: 12.345679, unit_price: 100.555555 };

    const jsonA = toCanonicalJson(stockA);
    const jsonB = toCanonicalJson(stockB);

    assert.equal(jsonA, jsonB);
    assert.equal(jsonA, '{"quantity":12.345679,"unit_price":100.555555}');
  });

  await t.test('5. Non-finite numbers — NaN, Infinity, -Infinity normalized to 0', async () => {
    const invalidNumbers = { inr: NaN, actual_amount: Infinity, quantity: -Infinity };
    const json = toCanonicalJson(invalidNumbers);

    assert.equal(json, '{"actual_amount":0,"inr":0,"quantity":0}');
  });

  await t.test('6. Unicode NFC normalization — composed and decomposed characters yield identical fingerprint', async () => {
    // \u00E9 is precomposed 'é'; 'e\u0301' is 'e' + combining acute accent
    const entityComposed = { note: 'Caf\u00E9 expense' };
    const entityDecomposed = { note: 'Cafe\u0301 expense' };

    const jsonComposed = toCanonicalJson(entityComposed);
    const jsonDecomposed = toCanonicalJson(entityDecomposed);

    assert.equal(jsonComposed, jsonDecomposed);

    const hashComposed = await computeCanonicalSha256(entityComposed);
    const hashDecomposed = await computeCanonicalSha256(entityDecomposed);

    assert.equal(hashComposed, hashDecomposed);
  });

  await t.test('7. Null vs Undefined handling — null is preserved, undefined is omitted', async () => {
    const entity = {
      id: 'txn_1',
      description: null,
      note: undefined,
      category: ''
    };

    const json = toCanonicalJson(entity);
    assert.equal(json, '{"category":"","description":null,"id":"txn_1"}');
    assert.ok(!json.includes('note'));
  });

  await t.test('8. Array preservation — array item order is preserved while child objects are canonicalized', async () => {
    const entity = {
      items: [
        { z: 2, a: 1 },
        { z: 4, a: 3 }
      ]
    };

    const json = toCanonicalJson(entity);
    assert.equal(json, '{"items":[{"a":1,"z":2},{"a":3,"z":4}]}');
  });

  await t.test('9. Fixed Test Vector Hash Verification — deterministic SHA-256 digest stability', async () => {
    const testEntity = {
      id: 'txn_snap_v8_001',
      date: '2026-09-27',
      time: '14:30',
      account: 'HDFC Bank',
      category: 'Food & Dining',
      subcategory: 'Groceries',
      inr: 1250.75,
      note: 'Weekly provisions',
      tags: '#stock #food'
    };

    const canonicalString = toCanonicalJson(testEntity);
    const expectedCanonicalString = '{"account":"HDFC Bank","category":"Food & Dining","date":"2026-09-27","id":"txn_snap_v8_001","inr":1250.75,"note":"Weekly provisions","subcategory":"Groceries","tags":"#stock #food","time":"14:30"}';
    assert.equal(canonicalString, expectedCanonicalString);

    const hash = await computeCanonicalSha256(testEntity);
    assert.equal(hash.length, 64);
    assert.equal(hash, hash.toLowerCase());

    // Re-verify hash calculation against known string
    const encoder = new TextEncoder();
    const expectedBuffer = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(expectedCanonicalString));
    const expectedHash = Array.from(new Uint8Array(expectedBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    assert.equal(hash, expectedHash);
  });

  await t.test('10. Version invariant — CANONICALIZATION_VERSION is 1', () => {
    assert.equal(CANONICALIZATION_VERSION, 1);
  });
});
