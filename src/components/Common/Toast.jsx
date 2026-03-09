import React from 'react';
import { useApp } from '../../contexts/AppContext.jsx';

export default function Toast() {
  const { state } = useApp();
  if (!state.toasts.length) return null;
  return (
    <div className="toast-container">
      {state.toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.kind||'success'}`}>{t.message}</div>
      ))}
    </div>
  );
}
