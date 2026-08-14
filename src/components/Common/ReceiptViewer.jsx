import React from 'react';

export default function ReceiptViewer({ receiptUrl, title = 'Receipt / Invoice', onClose }) {
  if (!receiptUrl) return null;

  return (
    <>
      <div className="fullscreen-overlay" onClick={onClose} />
      <div className="fullscreen-modal" style={{ background: '#000', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 16px', background: 'rgba(20,20,30,0.9)', borderBottom: '1px solid rgba(255,255,255,0.1)',
          zIndex: 10
        }}>
          <div style={{ fontSize: '0.92rem', fontWeight: 800, color: '#fff' }}>🧾 {title}</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <a
              href={receiptUrl}
              download="receipt.jpg"
              style={{
                background: 'rgba(255,255,255,0.15)', color: '#fff', padding: '5px 10px',
                borderRadius: 8, fontSize: '0.72rem', fontWeight: 700, textDecoration: 'none'
              }}
            >
              ⬇ Download
            </a>
            <button
              onClick={onClose}
              style={{
                width: 32, height: 32, borderRadius: '50%', background: 'rgba(255,255,255,0.2)',
                border: 'none', color: '#fff', fontSize: '1.1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Image Container with pinch/zoom support */}
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'auto', padding: 10
        }}>
          <img
            src={receiptUrl}
            alt="Attached Receipt"
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.8)' }}
          />
        </div>
      </div>
    </>
  );
}
