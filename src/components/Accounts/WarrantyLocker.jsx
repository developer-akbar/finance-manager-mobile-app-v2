import React, { useState, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, parseDate } from '../../utils/format.js';
import ReceiptViewer from '../Common/ReceiptViewer.jsx';
import AddTransaction from '../Transactions/AddTransaction.jsx';

export default function WarrantyLocker({ onBack, backInterceptRef }) {
  const { state } = useApp();
  const { transactions } = state;
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [editTxn, setEditTxn] = useState(null);
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState('active'); // 'active' | 'all' | 'expired'

  const today = new Date();

  // Extract all transactions with warranty or receipt attachments
  const warrantyItems = useMemo(() => {
    const list = [];
    for (const t of transactions) {
      if (t.warranty_expiry || t.receipt_image || t.serial_no || (t.Note && /warranty|invoice|receipt/i.test(t.Note))) {
        let isExpired = false;
        let daysLeft = null;
        let expiryDateObj = null;

        if (t.warranty_expiry) {
          expiryDateObj = new Date(t.warranty_expiry);
          const diffTime = expiryDateObj.getTime() - today.getTime();
          daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
          isExpired = daysLeft < 0;
        }

        list.push({
          rawTxn: t,
          title: t.Note || t.Category,
          amount: parseFloat(t.INR || t.Amount || 0),
          purchaseDate: t.Date,
          warrantyExpiry: t.warranty_expiry,
          serialNo: t.serial_no,
          receiptImage: t.receipt_image,
          daysLeft,
          isExpired,
        });
      }
    }

    return list.sort((a, b) => {
      if (a.daysLeft !== null && b.daysLeft !== null) return a.daysLeft - b.daysLeft;
      return parseDate(b.purchaseDate) - parseDate(a.purchaseDate);
    });
  }, [transactions, today]);

  const filteredItems = useMemo(() => {
    let res = warrantyItems;
    if (search.trim()) {
      const q = search.toLowerCase();
      res = res.filter(item => (item.title + ' ' + (item.serialNo || '')).toLowerCase().includes(q));
    }
    if (filterMode === 'active') {
      res = res.filter(item => item.daysLeft === null || item.daysLeft >= 0);
    } else if (filterMode === 'expired') {
      res = res.filter(item => item.daysLeft !== null && item.daysLeft < 0);
    }
    return res;
  }, [warrantyItems, search, filterMode]);

  return (
    <div className="sub-screen" style={{ background: 'var(--bg-base)', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <div>
          <div className="page-hdr-title">🛡️ Warranty &amp; Receipt Locker</div>
          <div className="page-hdr-sub">Track active gadget warranties &amp; bill photos</div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px var(--page-px) calc(var(--nav-height, 56px) + var(--safe-bottom, 0px) + 32px)', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Search & Filter pills */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="text"
            className="form-input"
            style={{ fontSize: '0.82rem', padding: '8px 12px' }}
            placeholder="Search appliance, brand, invoice no..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />

          <div style={{ display: 'flex', gap: 6 }}>
            {['active', 'all', 'expired'].map(mode => (
              <button
                key={mode}
                onClick={() => setFilterMode(mode)}
                style={{
                  flex: 1, padding: '5px 0', borderRadius: 16, fontSize: '0.72rem', fontWeight: 700,
                  textTransform: 'capitalize',
                  border: filterMode === mode ? '1.5px solid var(--accent)' : '1px solid var(--border)',
                  background: filterMode === mode ? 'rgba(0, 229, 160, 0.15)' : 'var(--bg-card)',
                  color: filterMode === mode ? 'var(--accent)' : 'var(--text-muted)',
                  cursor: 'pointer'
                }}
              >
                {mode === 'active' ? '🛡️ Active Warranties' : mode === 'expired' ? '⚠️ Expired' : 'All Attachments'}
              </button>
            ))}
          </div>
        </div>

        {/* List of Warranties */}
        {filteredItems.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 36, fontSize: '0.82rem' }}>
            {search ? 'No matching warranty items found.' : 'No receipts or warranties attached yet. When adding an expense, attach a bill photo or set a warranty date to track it here!'}
          </div>
        ) : (
          filteredItems.map((item, idx) => (
            <div
              key={item.rawTxn._id || idx}
              style={{
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 14, padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
                cursor: 'pointer', transition: 'all 0.15s'
              }}
              onClick={() => setEditTxn(item.rawTxn)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: '0.9rem', fontWeight: 800 }}>{item.title}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                    Purchased on {item.purchaseDate} • {formatINR(item.amount)}
                  </div>
                </div>

                {item.receiptImage && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedReceipt({ url: item.receiptImage, title: item.title });
                    }}
                    style={{
                      background: 'rgba(0, 229, 160, 0.15)', border: '1px solid var(--accent)',
                      color: 'var(--accent)', padding: '3px 8px', borderRadius: 8, fontSize: '0.68rem', fontWeight: 700, cursor: 'pointer'
                    }}
                  >
                    🧾 View Bill
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                {item.warrantyExpiry ? (
                  item.isExpired ? (
                    <span style={{ fontSize: '0.68rem', padding: '2px 8px', borderRadius: 6, background: 'rgba(255, 77, 106, 0.15)', color: 'var(--expense)', fontWeight: 700 }}>
                      ⚠️ Expired on {item.warrantyExpiry}
                    </span>
                  ) : (
                    <span style={{ fontSize: '0.68rem', padding: '2px 8px', borderRadius: 6, background: 'rgba(0, 229, 160, 0.15)', color: 'var(--income)', fontWeight: 700 }}>
                      🛡️ {item.daysLeft} days warranty remaining (Expires {item.warrantyExpiry})
                    </span>
                  )
                ) : (
                  <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>🧾 Receipt saved</span>
                )}

                {item.serialNo && (
                  <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                    SN: {item.serialNo}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {selectedReceipt && (
        <ReceiptViewer
          receiptUrl={selectedReceipt.url}
          title={selectedReceipt.title}
          onClose={() => setSelectedReceipt(null)}
        />
      )}

      {editTxn && (
        <AddTransaction
          editTransaction={editTxn}
          onClose={() => setEditTxn(null)}
          onSaveAndContinue={() => setEditTxn(null)}
          backInterceptRef={backInterceptRef}
        />
      )}
    </div>
  );
}
