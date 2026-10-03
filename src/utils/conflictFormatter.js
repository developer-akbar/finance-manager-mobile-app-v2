/**
 * conflictFormatter.js — Pure UI Formatting & Diff Helpers for Cloud Sync Conflicts (Stage B2)
 * 
 * Provides:
 * 1. formatConflictEntity(conflict): Transforms raw conflict records and payloads into human-readable titles,
 *    subtitles, metadata, and friendly descriptions.
 * 2. calculateEntityDiff(localPayload, remotePayload, collection): Computes a safe, normalized field-by-field diff
 *    between local and remote versions without exposing internal cryptographic checksums or IDs.
 * 3. getFriendlyConflictType(conflictType): Translates internal conflict enums into clear, non-technical labels.
 * 
 * Pure, side-effect-free utility:
 * - No database imports
 * - No React imports
 * - No sync-engine imports
 * - No network calls
 */

// ── Friendly Conflict Type Mapping ───────────────────────────────────────────
export const FRIENDLY_CONFLICT_TYPES = Object.freeze({
  CONCURRENT_EDIT: 'Simultaneous Edit',
  REMOTE_DELETE_LOCAL_EDIT: 'Deleted on Other Device',
  LOCAL_DELETE_REMOTE_EDIT: 'Deleted Locally, Edited on Other Device',
  CONCURRENT_DELETE: 'Deleted on Both Devices',
  CONCURRENT_RECREATE: 'Recreated on Both Devices',
  STALE_RESURRECTION: 'Stale Record Conflict',
  SCHEMA_MISMATCH: 'Version Format Mismatch'
});

export function getFriendlyConflictType(conflictType) {
  if (!conflictType) return 'Conflict Detected';
  return FRIENDLY_CONFLICT_TYPES[conflictType] || 'Conflict Detected';
}

// ── Collection Classification ────────────────────────────────────────────────
export function getFriendlyCollection(collection) {
  if (!collection) return 'Record';
  const c = String(collection).toLowerCase().trim();
  switch (c) {
    case 'transactions':
    case 'transaction':
      return 'Transaction';
    case 'accounts':
    case 'account':
      return 'Account';
    case 'categories':
    case 'category':
      return 'Category';
    case 'settings':
    case 'setting':
      return 'Setting';
    default:
      return c.charAt(0).toUpperCase() + c.slice(1);
  }
}

// ── Formatting Helpers (Standalone, Safe) ────────────────────────────────────
export function formatINR(amount) {
  if (amount === null || amount === undefined || isNaN(Number(amount))) return '';
  const num = Number(amount);
  const abs = Math.abs(num);
  return '₹' + abs.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatFriendlyDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  
  // Try YYYY-MM-DD
  const ymd = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (ymd) {
    const y = +ymd[1];
    const m = +ymd[2] - 1;
    const d = +ymd[3];
    if (m >= 0 && m < 12) {
      return `${d} ${MONTHS_SHORT[m]} ${y}`;
    }
  }

  // Try DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) {
    const d = +dmy[1];
    const m = +dmy[2] - 1;
    const y = +dmy[3];
    if (m >= 0 && m < 12) {
      return `${d} ${MONTHS_SHORT[m]} ${y}`;
    }
  }

  // General Date parse fallback
  const dt = new Date(s);
  if (!isNaN(dt.getTime()) && dt.getFullYear() > 1970) {
    return `${dt.getDate()} ${MONTHS_SHORT[dt.getMonth()]} ${dt.getFullYear()}`;
  }

  return s;
}

export function normalizeDateKey(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const ymd = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (ymd) {
    return `${ymd[1]}-${String(ymd[2]).padStart(2, '0')}-${String(ymd[3]).padStart(2, '0')}`;
  }
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) {
    return `${dmy[3]}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`;
  }
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }
  return s;
}

export function formatTransactionType(rawType) {
  if (!rawType) return '';
  const t = String(rawType).toLowerCase().trim();
  switch (t) {
    case 'expense':
      return 'Expense';
    case 'income':
      return 'Income';
    case 'transfer':
      return 'Transfer';
    case 'investment':
      return 'Investment';
    default:
      return t.charAt(0).toUpperCase() + t.slice(1);
  }
}

// ── Extract Human-Readable Title & Subtitle for an Entity ─────────────────────
export function extractEntityDescriptor(payload, collection = 'transactions') {
  if (!payload || typeof payload !== 'object') {
    return {
      title: 'Unavailable / Deleted',
      subtitle: '',
      note: '',
      amount: '',
      date: '',
      category: '',
      account: '',
      type: '',
      person: '',
      isDeleted: true
    };
  }

  const coll = String(collection).toLowerCase().trim();

  // Transactions
  if (coll.includes('trans')) {
    const rawNote = payload.note || payload.description || payload.name || payload.title || payload.Note || payload.Description || '';
    const note = String(rawNote).trim();
    const type = formatTransactionType(payload.type || payload.Type || '');
    const amountVal = payload.amount !== undefined ? payload.amount : payload.Amount;
    const amountStr = amountVal !== undefined && amountVal !== null && amountVal !== '' ? formatINR(amountVal) : '';
    const dateVal = payload.date || payload.Date || '';
    const dateStr = dateVal ? formatFriendlyDate(dateVal) : '';
    const category = payload.category || payload.Category || '';
    const account = payload.account || payload.Account || '';
    const person = payload.person || payload.Person || '';

    let title = '';
    if (type && note) {
      title = `${type} — ${note}`;
    } else if (note) {
      title = note;
    } else if (type && category) {
      title = `${type} — ${category}`;
    } else if (type) {
      title = `${type} Transaction`;
    } else if (category) {
      title = `Transaction (${category})`;
    } else {
      title = 'Untitled Transaction';
    }

    const metadataParts = [];
    if (amountStr) metadataParts.push(amountStr);
    if (dateStr) metadataParts.push(dateStr);
    if (category) metadataParts.push(category);
    const subtitle = metadataParts.join(' · ');

    return {
      title,
      subtitle,
      note: note || (category ? `Category: ${category}` : 'Untitled Record'),
      amount: amountStr,
      date: dateStr,
      category,
      account,
      type: type || 'Transaction',
      person,
      isDeleted: false
    };
  }

  // Accounts
  if (coll.includes('account')) {
    const name = payload.name || payload.account_name || payload.accountName || payload.title || 'Unnamed Account';
    const type = payload.type ? ` (${payload.type})` : '';
    const balance = payload.balance !== undefined ? `Balance: ${formatINR(payload.balance)}` : '';
    const subtitle = [type.trim(), balance].filter(Boolean).join(' · ');

    return {
      title: `Account — ${name}`,
      subtitle,
      note: name,
      amount: balance,
      date: '',
      category: '',
      account: name,
      type: 'Account',
      person: '',
      isDeleted: false
    };
  }

  // Categories
  if (coll.includes('categor')) {
    const name = payload.name || payload.category_name || payload.categoryName || 'Unnamed Category';
    const type = payload.type ? String(payload.type).trim() : '';
    return {
      title: `Category — ${name}`,
      subtitle: type,
      note: name,
      amount: '',
      date: '',
      category: name,
      account: '',
      type: 'Category',
      person: '',
      isDeleted: false
    };
  }

  // Settings
  if (coll.includes('setting')) {
    const key = payload.key || payload.id || 'Setting';
    const val = payload.value !== undefined ? String(payload.value) : '';
    return {
      title: `Setting — ${key}`,
      subtitle: val ? `Value: ${val}` : '',
      note: key,
      amount: '',
      date: '',
      category: '',
      account: '',
      type: 'Setting',
      person: '',
      isDeleted: false
    };
  }

  // Generic Entity Fallback
  const name = payload.name || payload.note || payload.description || payload.title || 'Record';
  return {
    title: `${getFriendlyCollection(collection)} — ${name}`,
    subtitle: '',
    note: String(name),
    amount: '',
    date: '',
    category: '',
    account: '',
    type: getFriendlyCollection(collection),
    person: '',
    isDeleted: false
  };
}

// ── Primary Conflict Formatter ────────────────────────────────────────────────
/**
 * Transforms a conflict record into clean, human-readable descriptors for presentation.
 */
export function formatConflictEntity(conflict = {}) {
  const collection = conflict?.collection || 'transactions';
  const conflictType = conflict?.conflict_type || 'CONCURRENT_EDIT';
  const entityId = conflict?.entity_id || '';
  const localPayload = conflict?.local_payload;
  const remotePayload = conflict?.remote_payload;

  const collectionLabel = getFriendlyCollection(collection);
  const friendlyType = getFriendlyConflictType(conflictType);

  const localDescriptor = extractEntityDescriptor(localPayload, collection);
  const remoteDescriptor = extractEntityDescriptor(remotePayload, collection);

  // Derive primary title: prefer local title if present, otherwise remote
  let primaryTitle = 'Untitled Record';
  let primarySubtitle = '';

  if (!localDescriptor.isDeleted && localDescriptor.title !== 'Unavailable / Deleted') {
    primaryTitle = localDescriptor.title;
    primarySubtitle = localDescriptor.subtitle;
  } else if (!remoteDescriptor.isDeleted && remoteDescriptor.title !== 'Unavailable / Deleted') {
    primaryTitle = remoteDescriptor.title;
    primarySubtitle = remoteDescriptor.subtitle;
  } else {
    primaryTitle = `${collectionLabel} (${entityId.slice(0, 8)})`;
  }

  const isRemoteDeleted = conflictType === 'REMOTE_DELETE_LOCAL_EDIT' || (!remotePayload && localPayload);
  const isLocalDeleted = conflictType === 'LOCAL_DELETE_REMOTE_EDIT' || (!localPayload && remotePayload);

  return {
    collection,
    collectionLabel,
    conflictType,
    friendlyType,
    rawEntityId: entityId,
    shortEntityId: entityId ? entityId.slice(0, 8) : '',
    primaryTitle,
    primarySubtitle,
    localDescriptor,
    remoteDescriptor,
    isRemoteDeleted,
    isLocalDeleted,
    peerDeviceLabel: 'Other Device'
  };
}

// ── Field Difference Calculator ───────────────────────────────────────────────
/**
 * Computes side-by-side field differences between local and remote payloads.
 * Returns an array of comparison fields categorized by changed status.
 */
export function calculateEntityDiff(localPayload, remotePayload, collection = 'transactions') {
  const coll = String(collection).toLowerCase().trim();

  // Handle deletion cases
  if (!localPayload && !remotePayload) {
    return {
      isDeleteConflict: true,
      hasChanges: false,
      changedFields: [],
      unchangedFields: [],
      allFields: []
    };
  }

  if (!localPayload && remotePayload) {
    return {
      isDeleteConflict: true,
      hasChanges: true,
      deleteMessage: 'Deleted locally, but modified on the other device.',
      changedFields: [
        {
          key: 'status',
          label: 'Status',
          localValue: 'Deleted on This Device',
          remoteValue: 'Active on Other Device',
          changed: true
        }
      ],
      unchangedFields: [],
      allFields: []
    };
  }

  if (localPayload && !remotePayload) {
    return {
      isDeleteConflict: true,
      hasChanges: true,
      deleteMessage: 'Deleted on the other device, but modified on this device.',
      changedFields: [
        {
          key: 'status',
          label: 'Status',
          localValue: 'Active on This Device',
          remoteValue: 'Deleted on Other Device',
          changed: true
        }
      ],
      unchangedFields: [],
      allFields: []
    };
  }

  const allFields = [];

  // Transactions: Canonical high-priority financial fields
  if (coll.includes('trans')) {
    // 1. Amount
    const localAmtVal = localPayload.amount !== undefined ? localPayload.amount : localPayload.Amount;
    const remoteAmtVal = remotePayload.amount !== undefined ? remotePayload.amount : remotePayload.Amount;
    const hasLocalAmt = localAmtVal !== undefined && localAmtVal !== null && localAmtVal !== '';
    const hasRemoteAmt = remoteAmtVal !== undefined && remoteAmtVal !== null && remoteAmtVal !== '';

    if (hasLocalAmt || hasRemoteAmt) {
      const numLocal = Number(localAmtVal);
      const numRemote = Number(remoteAmtVal);
      const amtChanged = (isNaN(numLocal) || isNaN(numRemote))
        ? String(localAmtVal) !== String(remoteAmtVal)
        : Math.abs(numLocal - numRemote) > 0.0001;

      allFields.push({
        key: 'amount',
        label: 'Amount',
        localValue: hasLocalAmt ? formatINR(localAmtVal) : '—',
        remoteValue: hasRemoteAmt ? formatINR(remoteAmtVal) : '—',
        changed: amtChanged
      });
    }

    // 2. Note / Description
    const localNote = String(localPayload.note || localPayload.description || localPayload.Note || localPayload.Description || '').trim();
    const remoteNote = String(remotePayload.note || remotePayload.description || remotePayload.Note || remotePayload.Description || '').trim();
    if (localNote || remoteNote) {
      allFields.push({
        key: 'note',
        label: 'Note / Description',
        localValue: localNote || '—',
        remoteValue: remoteNote || '—',
        changed: localNote !== remoteNote
      });
    }

    // 3. Date
    const localDate = localPayload.date || localPayload.Date || '';
    const remoteDate = remotePayload.date || remotePayload.Date || '';
    if (localDate || remoteDate) {
      const normLocal = normalizeDateKey(localDate);
      const normRemote = normalizeDateKey(remoteDate);
      allFields.push({
        key: 'date',
        label: 'Date',
        localValue: localDate ? formatFriendlyDate(localDate) : '—',
        remoteValue: remoteDate ? formatFriendlyDate(remoteDate) : '—',
        changed: normLocal !== normRemote
      });
    }

    // 4. Category
    const localCat = String(localPayload.category || localPayload.Category || '').trim();
    const remoteCat = String(remotePayload.category || remotePayload.Category || '').trim();
    if (localCat || remoteCat) {
      allFields.push({
        key: 'category',
        label: 'Category',
        localValue: localCat || '—',
        remoteValue: remoteCat || '—',
        changed: localCat !== remoteCat
      });
    }

    // 5. Account
    const localAcc = String(localPayload.account || localPayload.Account || '').trim();
    const remoteAcc = String(remotePayload.account || remotePayload.Account || '').trim();
    if (localAcc || remoteAcc) {
      allFields.push({
        key: 'account',
        label: 'Account',
        localValue: localAcc || '—',
        remoteValue: remoteAcc || '—',
        changed: localAcc !== remoteAcc
      });
    }

    // 6. Type
    const localType = String(localPayload.type || localPayload.Type || '').trim();
    const remoteType = String(remotePayload.type || remotePayload.Type || '').trim();
    if (localType || remoteType) {
      allFields.push({
        key: 'type',
        label: 'Type',
        localValue: formatTransactionType(localType) || '—',
        remoteValue: formatTransactionType(remoteType) || '—',
        changed: localType.toLowerCase() !== remoteType.toLowerCase()
      });
    }

    // 7. Person
    const localPerson = String(localPayload.person || localPayload.Person || '').trim();
    const remotePerson = String(remotePayload.person || remotePayload.Person || '').trim();
    if (localPerson || remotePerson) {
      allFields.push({
        key: 'person',
        label: 'Person / Owner',
        localValue: localPerson || '—',
        remoteValue: remotePerson || '—',
        changed: localPerson !== remotePerson
      });
    }
  } else {
    // Non-transaction entities: dynamic key comparison ignoring internal metadata
    const ignoredKeys = new Set([
      'id', '_id', 'entity_id', 'created_at', 'updated_at',
      'checksum', 'sync_status', 'deleted', 'synced', 'local_checksum',
      'remote_checksum', 'base_checksum'
    ]);

    const combinedKeys = Array.from(new Set([
      ...Object.keys(localPayload || {}),
      ...Object.keys(remotePayload || {})
    ])).filter(k => !ignoredKeys.has(k.toLowerCase()));

    for (const k of combinedKeys) {
      const lVal = localPayload ? localPayload[k] : undefined;
      const rVal = remotePayload ? remotePayload[k] : undefined;
      const lStr = lVal !== undefined && lVal !== null ? (typeof lVal === 'object' ? JSON.stringify(lVal) : String(lVal)) : '—';
      const rStr = rVal !== undefined && rVal !== null ? (typeof rVal === 'object' ? JSON.stringify(rVal) : String(rVal)) : '—';
      
      const changed = lStr !== rStr;
      const label = k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ');

      allFields.push({
        key: k,
        label,
        localValue: lStr,
        remoteValue: rStr,
        changed
      });
    }
  }

  const changedFields = allFields.filter(f => f.changed);
  const unchangedFields = allFields.filter(f => !f.changed);

  return {
    isDeleteConflict: false,
    hasChanges: changedFields.length > 0,
    changedFields,
    unchangedFields,
    allFields
  };
}
