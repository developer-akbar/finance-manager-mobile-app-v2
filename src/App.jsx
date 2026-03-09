import React, { useState, useEffect } from 'react';
import { initDB } from './database/db.js';
import { AppProvider } from './contexts/AppContext.jsx';
import Shell from './components/Layout/Shell.jsx';
import PinLock from './components/Settings/PinLock.jsx';
import Toast from './components/Common/Toast.jsx';

// Module-level: survives React re-renders within the session
let _sessionUnlocked = false;

function AppInner() {
  return (
    <>
      <Shell />
      <Toast />
    </>
  );
}

export default function App() {
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState(null);

  useEffect(() => {
    initDB()
      .then(() => setDbReady(true))
      .catch(e => setDbError(e.message || 'Database failed'));
  }, []);

  if (dbError) return (
    <div style={{ display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
      height:'100dvh',padding:32,gap:12,background:'#0a0f1e',color:'#ff4d6a',textAlign:'center' }}>
      <div style={{ fontSize:40 }}>⚠️</div>
      <div style={{ fontSize:20,fontWeight:700,fontFamily:'Sora,sans-serif' }}>Database Error</div>
      <div style={{ fontSize:14,color:'#8899bb',fontFamily:'Sora,sans-serif' }}>{dbError}</div>
      <div style={{ fontSize:12,color:'#4a5a7a',fontFamily:'Sora,sans-serif' }}>Please restart the app</div>
    </div>
  );

  if (!dbReady) return (
    <div className="loading-screen">
      <div className="loading-logo">F</div>
      <div className="loading-title">FinMan</div>
      <div className="loading-sub">Loading your finances…</div>
      <div className="loading-bar"></div>
    </div>
  );

  return (
    <AppProvider>
      <PinLock sessionUnlockedRef={{ current: _sessionUnlocked, set: v => _sessionUnlocked = v }}>
        <AppInner />
      </PinLock>
    </AppProvider>
  );
}
