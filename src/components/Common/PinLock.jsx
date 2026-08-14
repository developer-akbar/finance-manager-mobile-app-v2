import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';

let _sessionUnlocked = false;

export default function PinLock({ children }) {
  const { state } = useApp();
  const pin      = state.settings?.pin || '';
  const enabled  = !!pin;

  const [locked,   setLocked]   = useState(false);
  const [entry,    setEntry]    = useState('');
  const [error,    setError]    = useState('');
  const [attempts, setAttempts] = useState(0);
  const bgTime = useRef(null);

  // Lock on initial open if PIN is set and session not unlocked yet
  useEffect(() => {
    if (!enabled) { setLocked(false); _sessionUnlocked = false; return; }
    if (!_sessionUnlocked) setLocked(true);
  }, [enabled]);

  // Lock ONLY when app goes to background for ≥5 seconds then returns
  // (device switch, home button, etc.) — NOT on idle timeout
  useEffect(() => {
    if (!enabled) return;

    const onVis = () => {
      if (document.hidden) {
        // App going to background — record time
        bgTime.current = Date.now();
      } else {
        // App returning to foreground
        if (bgTime.current !== null) {
          const elapsed = Date.now() - bgTime.current;
          bgTime.current = null;
          if (elapsed >= 5000) {
            // 5+ seconds in background → lock
            _sessionUnlocked = false;
            setEntry(''); setError(''); setAttempts(0);
            setLocked(true);
          }
          // < 5 seconds → don't lock (brief switch / notification)
        }
      }
    };

    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [enabled]);

  // Also handle Capacitor appStateChange (Android back-to-foreground)
  useEffect(() => {
    if (!enabled) return;
    let sub = null;
    const setup = async () => {
      try {
        const { App } = await import('@capacitor/app');
        sub = await App.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) {
            bgTime.current = Date.now();
          } else {
            if (bgTime.current !== null) {
              const elapsed = Date.now() - bgTime.current;
              bgTime.current = null;
              if (elapsed >= 5000) {
                _sessionUnlocked = false;
                setEntry(''); setError(''); setAttempts(0);
                setLocked(true);
              }
            }
          }
        });
      } catch { /* not Capacitor */ }
    };
    setup();
    return () => { sub?.remove?.(); };
  }, [enabled]);

  const triggerBiometricUnlock = async () => {
    try {
      if (window.Capacitor && window.Capacitor.isNativePlatform?.() && state.settings?.biometricsEnabled === 'true') {
        const { NativeBiometric } = await import('@capgo/capacitor-native-biometric');
        const avail = await NativeBiometric.isAvailable();
        if (avail.isAvailable) {
          await NativeBiometric.verifyIdentity({
            reason: 'Unlock FinMan',
            title: 'Biometric Unlock',
            subtitle: 'Unlock app',
            description: 'Scan your fingerprint or face to unlock FinMan',
          });
          _sessionUnlocked = true;
          setLocked(false); setEntry(''); setError(''); setAttempts(0);
        }
      }
    } catch (err) {
      console.warn('Biometric unlock failed or cancelled:', err);
    }
  };

  useEffect(() => {
    if (locked && enabled && state.settings?.biometricsEnabled === 'true') {
      triggerBiometricUnlock();
    }
  }, [locked, enabled, state.settings?.biometricsEnabled]);

  const verify = (e) => {
    if (e === pin) {
      _sessionUnlocked = true;
      setLocked(false); setEntry(''); setError(''); setAttempts(0);
    } else {
      const n = attempts + 1; setAttempts(n); setEntry('');
      if (n >= 5) {
        setError('Too many attempts. Wait 30s.');
        setTimeout(() => { setAttempts(0); setError(''); }, 30000);
      } else {
        setError(`Wrong PIN — ${5 - n} attempt${5 - n !== 1 ? 's' : ''} left`);
      }
    }
  };

  const tap = (d) => {
    if (attempts >= 5) return;
    const next = entry + d;
    setEntry(next); setError('');
    if (next.length === (pin.length || 4)) verify(next);
  };

  const KEYS   = ['1','2','3','4','5','6','7','8','9', (state.settings?.biometricsEnabled === 'true' ? '🔑' : ''), '0', '⌫'];
  const pinLen = pin.length || 4;

  return (
    <>
      {children}
      {enabled && locked && (
        <div style={{
          position:'fixed', inset:0, zIndex:99999,
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
          background:'var(--bg-base)', padding:'24px 32px',
          fontFamily:'var(--font)',
        }}>
          <div style={{fontSize:48, marginBottom:8}}>🔒</div>
          <div style={{fontSize:26, fontWeight:800, color:'var(--green)', letterSpacing:-1, marginBottom:4}}>FinMan</div>
          <div style={{fontSize:13, color:'var(--text-muted)', marginBottom:28}}>Enter PIN to continue</div>

          {/* PIN dots */}
          <div style={{display:'flex', gap:14, marginBottom:20}}>
            {Array.from({length:pinLen}, (_, i) => (
              <div key={i} style={{
                width:14, height:14, borderRadius:'50%',
                background: i < entry.length ? 'var(--green)' : 'transparent',
                border: '2px solid var(--green)',
                transition: 'background 0.15s',
              }}/>
            ))}
          </div>

          {error && (
            <div style={{color:'var(--expense)', fontSize:13, fontWeight:600, marginBottom:14, textAlign:'center'}}>
              {error}
            </div>
          )}

          {/* Keypad — wider buttons */}
          <div style={{
            display:'grid', gridTemplateColumns:'repeat(3, 1fr)',
            gap:10, width:'100%', maxWidth:320,
          }}>
            {KEYS.map((k, i) => {
              if (k === '') return <span key={i}/>;
              return (
                <button key={i}
                  onClick={() => {
                    if (k === '⌫') {
                      setEntry(e => e.slice(0, -1));
                    } else if (k === '🔑') {
                      triggerBiometricUnlock();
                    } else {
                      tap(k);
                    }
                  }}
                  disabled={attempts >= 5 && k !== '🔑'}
                  style={{
                    height:64, fontSize: k === '⌫' || k === '🔑' ? 22 : 26,
                    fontWeight:600, cursor:'pointer',
                    borderRadius:13,
                    border:'1.5px solid var(--border)',
                    background: (k === '⌫' || k === '🔑') ? 'transparent' : 'var(--bg-card)',
                    color:'var(--text-primary)', fontFamily:'var(--font)',
                    opacity: (attempts >= 5 && k !== '🔑') ? 0.4 : 1,
                    transition:'all 0.15s',
                  }}>
                  {k === '🔑' ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 28, height: 28, display: 'block', margin: '0 auto', color: 'var(--green)' }}>
                      <path d="M2 12a10 10 0 0 1 18-6M22 12A10 10 0 0 1 12 22" />
                      <path d="M6 12a6 6 0 0 1 9-5.2M16.5 10.5A6 6 0 0 1 12 18" />
                      <path d="M10 12a2 2 0 0 1 2-2M12 14a2 2 0 0 1 0-4" />
                      <path d="M12 14v3" />
                    </svg>
                  ) : k}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
