import React, { useState, useEffect, useRef } from 'react';
import { getSetting } from '../../database/settings.js';
import { App as CapApp } from '@capacitor/app';

const LOCK_AFTER_MS = 30_000;

export default function PinLock({ children, sessionUnlockedRef }) {
  const [checked,   setChecked]   = useState(false);
  const [pinEnabled, setPinEnabled] = useState(false);
  const [storedPin,  setStoredPin]  = useState('');
  const [locked,     setLocked]     = useState(false);
  const [entry,      setEntry]      = useState('');
  const [shake,      setShake]      = useState(false);
  const [attempts,   setAttempts]   = useState(0);
  const [blocked,    setBlocked]    = useState(false);
  const bgTimeRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const pin     = await getSetting('app_pin');
        const enabled = await getSetting('app_pin_enabled');
        if (pin && enabled === 'true') {
          setStoredPin(pin);
          setPinEnabled(true);
          if (!sessionUnlockedRef.current) setLocked(true);
        }
      } catch (_) {}
      finally { setChecked(true); }
    })();
  }, []);

  useEffect(() => {
    if (!pinEnabled) return;
    let handle;
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) { bgTimeRef.current = Date.now(); }
      else if (bgTimeRef.current && Date.now()-bgTimeRef.current >= LOCK_AFTER_MS) {
        sessionUnlockedRef.set(false);
        setEntry(''); setAttempts(0); setBlocked(false); setLocked(true);
        bgTimeRef.current = null;
      } else { bgTimeRef.current = null; }
    }).then(h => { handle = h; });
    return () => { handle?.remove(); };
  }, [pinEnabled]);

  if (!checked) return null;
  if (!locked || !pinEnabled) return children;

  const pinLen = storedPin.length || 4;

  const handleDigit = (d) => {
    if (blocked) return;
    const next = entry + d;
    setEntry(next);
    if (next.length === pinLen) {
      if (next === storedPin) {
        sessionUnlockedRef.set(true);
        setLocked(false);
        setEntry(''); setAttempts(0);
      } else {
        const a = attempts + 1;
        setAttempts(a);
        setShake(true);
        setTimeout(() => setShake(false), 500);
        setEntry('');
        if (a >= 5) {
          setBlocked(true);
          setTimeout(() => { setBlocked(false); setAttempts(0); }, 30_000);
        }
      }
    }
  };

  const digits = [1,2,3,4,5,6,7,8,9,'',0,'⌫'];

  return (
    <div style={{
      position:'fixed',inset:0,zIndex:9999,
      background:'var(--bg)',
      display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
      padding:'0 40px',gap:0,
    }}>
      <div style={{fontSize:52,marginBottom:12}}>🔒</div>
      <div style={{fontSize:28,fontWeight:800,color:'var(--text)',fontFamily:'var(--font)'}}>FinMan</div>
      <div style={{fontSize:14,color:'var(--text3)',margin:'6px 0 36px'}}>
        {blocked ? `Too many attempts — wait 30s` : 'Enter your PIN to continue'}
      </div>

      {/* Dot indicators */}
      <div style={{display:'flex',gap:14,marginBottom:32}}>
        {Array.from({length:pinLen},(_,i)=>(
          <div key={i} style={{
            width:14,height:14,borderRadius:'50%',
            background: i<entry.length ? 'var(--green)' : 'transparent',
            border:'2px solid var(--green)',
            transition:'background 0.15s',
          }}/>
        ))}
      </div>

      {attempts > 0 && !blocked && (
        <div style={{fontSize:13,color:'var(--red)',marginBottom:16,fontWeight:600}}>
          Incorrect PIN — {5-attempts} attempt{5-attempts!==1?'s':''} left
        </div>
      )}

      {/* Numpad */}
      <div style={{
        display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14,
        width:'100%',maxWidth:280,
        animation: shake ? 'pinShake 0.5s' : 'none',
      }}>
        {digits.map((d,i)=>{
          if (d==='') return <span key={i}/>;
          const isDel = d==='⌫';
          return (
            <button key={i} onClick={() => isDel ? setEntry(e=>e.slice(0,-1)) : handleDigit(String(d))}
              disabled={blocked}
              style={{
                height:66,fontSize:isDel?22:26,fontWeight:isDel?400:700,
                borderRadius:16,
                border:'1.5px solid var(--border)',
                background:'var(--card)',
                color:'var(--text)',
                cursor:blocked?'not-allowed':'pointer',
                opacity:blocked?0.4:1,
                fontFamily:isDel?'system-ui':'var(--mono)',
                boxShadow:'var(--shadow-sm)',
                transition:'background 0.1s',
              }}
            >{d}</button>
          );
        })}
      </div>

      <style>{`@keyframes pinShake {
        0%,100%{transform:translateX(0)} 20%{transform:translateX(-8px)} 60%{transform:translateX(8px)}
      }`}</style>
    </div>
  );
}
