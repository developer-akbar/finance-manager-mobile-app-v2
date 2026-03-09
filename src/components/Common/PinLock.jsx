import React, { useState, useEffect, useRef } from 'react';
import { getSetting } from '../../database/settings.js';
import { App as CapacitorApp } from '@capacitor/app';

let _unlocked = false;
const LOCK_AFTER_MS = 30_000;

export default function PinLock({ children }) {
  const [checked,  setChecked]  = useState(false);
  const [enabled,  setEnabled]  = useState(false);
  const [locked,   setLocked]   = useState(false);
  const [pin,      setPin]      = useState('');
  const [entry,    setEntry]    = useState('');
  const [error,    setError]    = useState('');
  const [attempts, setAttempts] = useState(0);
  const bgTime = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const p  = await getSetting('app_pin');
        const on = await getSetting('app_pin_enabled');
        if (p && on === 'true') {
          setPin(p); setEnabled(true);
          if (!_unlocked) setLocked(true);
        }
      } catch {}
      finally { setChecked(true); }
    })();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let handle;
    CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) { bgTime.current = Date.now(); }
      else if (bgTime.current && Date.now() - bgTime.current >= LOCK_AFTER_MS) {
        _unlocked = false; setEntry(''); setError(''); setAttempts(0); setLocked(true);
        bgTime.current = null;
      }
    }).then(h => { handle = h; });
    return () => handle?.remove();
  }, [enabled]);

  if (!checked) return null;
  if (!locked || !enabled) return children;

  const verify = (e) => {
    if (e === pin) { _unlocked = true; setLocked(false); setEntry(''); setError(''); setAttempts(0); }
    else {
      const n = attempts + 1;
      setAttempts(n); setEntry('');
      if (n >= 5) { setError('Too many attempts. Wait 30s.'); setTimeout(() => { setAttempts(0); setError(''); }, 30000); }
      else setError(`Wrong PIN — ${5-n} attempt${5-n!==1?'s':''} left`);
    }
  };

  const tap = (d) => {
    if (attempts >= 5) return;
    const next = entry + d;
    setEntry(next); setError('');
    if (next.length === pin.length) verify(next);
  };

  const DIGITS = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  const pinLen = pin.length || 4;

  return (
    <div style={{
      position:'fixed', inset:0, zIndex:9999,
      display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
      background:'var(--bg-base)', padding:24, fontFamily:'var(--font)',
    }}>
      <div style={{ fontSize:52, marginBottom:8 }}>🔒</div>
      <div style={{ fontSize:24, fontWeight:800, color:'var(--text-primary)', marginBottom:4 }}>FinMan</div>
      <div style={{ fontSize:14, color:'var(--text-muted)', marginBottom:32 }}>Enter your PIN to continue</div>

      <div style={{ display:'flex', gap:14, marginBottom:32 }}>
        {Array.from({length:pinLen},(_,i) => (
          <div key={i} style={{
            width:14, height:14, borderRadius:'50%',
            background: i < entry.length ? 'var(--green)' : 'transparent',
            border: '2px solid var(--green)',
            transition: 'background 0.15s',
          }} />
        ))}
      </div>

      {error && <div style={{ color:'var(--expense)', fontSize:13, fontWeight:600, marginBottom:16, textAlign:'center' }}>{error}</div>}

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, width:'100%', maxWidth:260 }}>
        {DIGITS.map((d,i) => {
          if (d === '') return <span key={i} />;
          const isDel = d === '⌫';
          return (
            <button key={i} onClick={() => isDel ? setEntry(e => e.slice(0,-1)) : tap(d)}
              disabled={attempts >= 5}
              style={{
                height:64, fontSize: isDel ? 22 : 26, fontWeight:600, cursor:'pointer',
                borderRadius:14, border:'1.5px solid var(--border)',
                background: isDel ? 'transparent' : 'var(--bg-card)',
                color:'var(--text-primary)', fontFamily:'var(--font)',
                opacity: attempts >= 5 ? 0.4 : 1,
                transition: 'all 0.15s',
              }}>
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}
