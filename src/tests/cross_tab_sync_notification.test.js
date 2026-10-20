/**
 * cross_tab_sync_notification.test.js
 * 
 * Regression test suite for cross-tab sync status notification via BroadcastChannel.
 * 
 * Verifies:
 * 1. A receiving tab's subscriber is notified with the correct status and details.
 * 2. The receiving tab does not rebroadcast incoming events (preventing duplicate or recursive traffic).
 * 3. Existing same-tab notification behavior remains immediate and intact.
 * 4. Listener exceptions do not break notifications to other registered listeners.
 * 5. Unsubscribe stops receiving cross-tab notifications cleanly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  subscribeSyncStatus,
  broadcastSyncStatus,
  getCurrentSyncStatus,
  closeBroadcastChannel,
  getBroadcastChannel,
  SYNC_STATUS,
  SYNC_BROADCAST_CHANNEL_NAME
} from '../services/deltaSyncCoordinator.js';

test('FinMan — Cross-Tab Sync Notification Regression Suite', async (t) => {
  t.beforeEach(() => {
    closeBroadcastChannel();
  });

  t.afterEach(() => {
    closeBroadcastChannel();
  });

  await t.test('1. A receiving tab subscriber is notified with correct status and details via BroadcastChannel', async () => {
    const senderChannel = new BroadcastChannel(SYNC_BROADCAST_CHANNEL_NAME);
    const receivedEvents = [];

    const unsubscribe = subscribeSyncStatus((status, details) => {
      receivedEvents.push({ status, details });
    });

    const payload = {
      type: 'SYNC_STATUS_CHANGE',
      status: SYNC_STATUS.SUCCESS,
      details: {
        trigger: 'MANUAL',
        reconciliation: {
          reconciledCount: 1,
          conflictCount: 0
        }
      },
      timestamp: new Date().toISOString()
    };

    // Simulate another tab posting sync completion to BroadcastChannel
    senderChannel.postMessage(payload);

    // Await message delivery through event loop
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (receivedEvents.length > 0) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    unsubscribe();
    senderChannel.close();

    assert.strictEqual(receivedEvents.length, 1, 'Exactly one event received by subscriber');
    assert.strictEqual(receivedEvents[0].status, SYNC_STATUS.SUCCESS, 'Status matches incoming broadcast');
    assert.strictEqual(receivedEvents[0].details.reconciliation?.reconciledCount, 1, 'Details preserved');
    assert.strictEqual(receivedEvents[0].details.trigger, 'MANUAL', 'Trigger preserved');
    assert.strictEqual(getCurrentSyncStatus(), SYNC_STATUS.SUCCESS, 'Internal sync status updated');
  });

  await t.test('2. The receiving tab does not rebroadcast the incoming event', async () => {
    const senderChannel = new BroadcastChannel(SYNC_BROADCAST_CHANNEL_NAME);
    const senderReceived = [];
    senderChannel.onmessage = (evt) => {
      senderReceived.push(evt.data);
    };

    let receiverCallCount = 0;
    const unsubscribe = subscribeSyncStatus((status, details) => {
      receiverCallCount++;
      // Even if a listener invokes broadcastSyncStatus, recursion protection must suppress rebroadcast
      broadcastSyncStatus(status, details);
    });

    // Send from senderChannel
    senderChannel.postMessage({
      type: 'SYNC_STATUS_CHANGE',
      status: SYNC_STATUS.SUCCESS,
      details: { trigger: 'FOREGROUND', reconciliation: { reconciledCount: 3 } },
      timestamp: new Date().toISOString()
    });

    // Wait for receiver tab to process
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (receiverCallCount > 0) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    // Allow time for any potential rogue rebroadcast
    await new Promise((r) => setTimeout(r, 60));

    unsubscribe();
    senderChannel.close();

    assert.strictEqual(receiverCallCount, 1, 'Receiver listener was invoked');
    assert.strictEqual(senderReceived.length, 0, 'Sender received zero rebroadcast messages');
  });

  await t.test('3. Existing same-tab notification behavior remains correct and broadcasts outward', async () => {
    const peerChannel = new BroadcastChannel(SYNC_BROADCAST_CHANNEL_NAME);
    const peerReceived = [];
    peerChannel.onmessage = (evt) => {
      peerReceived.push(evt.data);
    };

    const localReceived = [];
    const unsubscribe = subscribeSyncStatus((status, details) => {
      localReceived.push({ status, details });
    });

    // Local tab initiates broadcast
    broadcastSyncStatus(SYNC_STATUS.SYNCING, { trigger: 'MUTATION' });

    // Local subscriber is notified synchronously
    assert.strictEqual(localReceived.length, 1, 'Local subscriber notified synchronously');
    assert.strictEqual(localReceived[0].status, SYNC_STATUS.SYNCING);
    assert.strictEqual(localReceived[0].details.trigger, 'MUTATION');
    assert.strictEqual(getCurrentSyncStatus(), SYNC_STATUS.SYNCING);

    // Await peerChannel receiving outward broadcast
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (peerReceived.length > 0) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    unsubscribe();
    peerChannel.close();

    assert.strictEqual(peerReceived.length, 1, 'External tab received outward broadcast');
    assert.strictEqual(peerReceived[0].status, SYNC_STATUS.SYNCING);
    assert.strictEqual(peerReceived[0].details.trigger, 'MUTATION');
  });

  await t.test('4. Listener exceptions do not break notifications to other listeners', async () => {
    const senderChannel = new BroadcastChannel(SYNC_BROADCAST_CHANNEL_NAME);
    const healthyReceived = [];

    // Failing listener 1
    const unsub1 = subscribeSyncStatus(() => {
      throw new Error('Simulated failure in listener 1');
    });

    // Healthy listener 2
    const unsub2 = subscribeSyncStatus((status, details) => {
      healthyReceived.push({ status, details });
    });

    // A. Cross-tab trigger
    senderChannel.postMessage({
      type: 'SYNC_STATUS_CHANGE',
      status: SYNC_STATUS.SUCCESS,
      details: { test: 'cross_tab_error_resilience' },
      timestamp: new Date().toISOString()
    });

    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (healthyReceived.length > 0) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    assert.strictEqual(healthyReceived.length, 1, 'Healthy listener received cross-tab message despite listener 1 error');
    assert.strictEqual(healthyReceived[0].details.test, 'cross_tab_error_resilience');

    // B. Local broadcast trigger
    healthyReceived.length = 0;
    broadcastSyncStatus(SYNC_STATUS.IDLE, { test: 'local_error_resilience' });

    assert.strictEqual(healthyReceived.length, 1, 'Healthy listener received local broadcast despite listener 1 error');
    assert.strictEqual(healthyReceived[0].status, SYNC_STATUS.IDLE);

    unsub1();
    unsub2();
    senderChannel.close();
  });

  await t.test('5. Unsubscribe stops receiving cross-tab notifications cleanly', async () => {
    const senderChannel = new BroadcastChannel(SYNC_BROADCAST_CHANNEL_NAME);
    const received = [];

    const unsubscribe = subscribeSyncStatus((status, details) => {
      received.push({ status, details });
    });

    // Unsubscribe immediately before event
    unsubscribe();

    senderChannel.postMessage({
      type: 'SYNC_STATUS_CHANGE',
      status: SYNC_STATUS.SUCCESS,
      details: { message: 'should be ignored' },
      timestamp: new Date().toISOString()
    });

    await new Promise((r) => setTimeout(r, 50));
    senderChannel.close();

    assert.strictEqual(received.length, 0, 'No events received after unsubscribe');
  });
});
