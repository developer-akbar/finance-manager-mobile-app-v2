import React, { useState, useEffect } from 'react';
import { getSetting, setSetting } from '../../database/settings.js';
import { useApp } from '../../contexts/AppContext.jsx';
import './Settings.css';

export default function ProfileMgr({ onBack }) {
  const { toast } = useApp();
  const [loaded,      setLoaded]      = useState(false);
  const [name,        setName]        = useState('');
  const [pinEnabled,  setPinEnabled]  = useState(false);
  const [hasPin,      setHasPin]      = useState(false);
  const [showPinForm, setShowPinForm] = useState(false);
  const [curPin,      setCurPin]      = useState('');
  const [newPin,      setNewPin]      = useState('');
  const [confPin,     setConfPin]     = useState('');
  const [pinMsg,      setPinMsg]      = useState('');
  const [saving,      setSaving]      = useState(false);

  useEffect(() => {
    (async () => {
      const n       = await getSetting('profile_name');
      const pin     = await getSetting('app_pin');
      const enabled = await getSetting('app_pin_enabled');
      if (n) setName(n);
      setHasPin(!!(pin&&pin.length>0));
      setPinEnabled(enabled==='true');
      setLoaded(true);
    })();
  }, []);

  const saveName = async () => {
    setSaving(true);
    await setSetting('profile_name', name);
    setSaving(false); toast('Profile updated ✓');
  };

  const togglePin = async () => {
    const next = !pinEnabled;
    await setSetting('app_pin_enabled', String(next));
    setPinEnabled(next);
    toast(next ? 'PIN lock enabled' : 'PIN lock disabled');
  };

  const savePin = async (e) => {
    e.preventDefault(); setPinMsg('');
    if (!/^\d{4,6}$/.test(newPin)) { setPinMsg('PIN must be 4–6 digits'); return; }
    if (newPin !== confPin)          { setPinMsg('PINs do not match'); return; }
    if (hasPin) {
      const stored = await getSetting('app_pin');
      if (stored !== curPin) { setPinMsg('Current PIN is incorrect'); return; }
    }
    await setSetting('app_pin', newPin);
    await setSetting('app_pin_enabled', 'true');
    setHasPin(true); setPinEnabled(true);
    setNewPin(''); setConfPin(''); setCurPin('');
    setShowPinForm(false);
    toast('PIN saved ✓');
  };

  const removePin = async () => {
    if (!window.confirm('Remove PIN lock?')) return;
    await setSetting('app_pin', '');
    await setSetting('app_pin_enabled', 'false');
    setHasPin(false); setPinEnabled(false);
    toast('PIN removed');
  };

  if (!loaded) return null;

  return (
    <div className="subpage settings-screen">
      <div className="subpage-header">
        <button className="back-btn" onClick={onBack}><BackIcon/></button>
        <div className="subpage-title">Profile</div>
      </div>

      {/* Display name */}
      <div className="mgr-section">
        <div className="settings-group-label" style={{padding:0,marginBottom:12}}>Display Name</div>
        <div className="card" style={{padding:16,display:'flex',gap:10}}>
          <input className="form-control" style={{flex:1}} placeholder="Your name" value={name} onChange={e=>setName(e.target.value)} />
          <button className="btn btn-primary" onClick={saveName} disabled={saving}>Save</button>
        </div>
      </div>

      {/* PIN lock */}
      <div className="mgr-section">
        <div className="settings-group-label" style={{padding:0,marginBottom:12}}>App Lock (PIN)</div>
        <div className="settings-list">
          <div className="settings-row" style={{borderBottom: hasPin ? '1px solid var(--border)' : 'none'}}>
            <div className="settings-row-icon">🔒</div>
            <div className="settings-row-text">
              <div className="settings-row-title">PIN Lock</div>
              <div className="settings-row-sub">
                {!hasPin ? 'No PIN set' : pinEnabled ? 'Enabled — locks after 30s background' : 'PIN set but disabled'}
              </div>
            </div>
            {hasPin && (
              <label className="toggle-wrap">
                <input type="checkbox" className="toggle-input" checked={pinEnabled} onChange={togglePin} />
                <span className="toggle-slider" />
              </label>
            )}
          </div>
          {hasPin && (
            <div className="settings-row last">
              <div style={{flex:1,display:'flex',gap:10}}>
                <button className="btn btn-secondary btn-sm" onClick={() => setShowPinForm(s=>!s)}>
                  Change PIN
                </button>
                <button className="btn btn-danger btn-sm" onClick={removePin}>
                  Remove PIN
                </button>
              </div>
            </div>
          )}
        </div>

        {!hasPin && (
          <button className="btn btn-primary btn-full" style={{marginTop:12}} onClick={() => setShowPinForm(s=>!s)}>
            Set PIN Lock
          </button>
        )}

        {showPinForm && (
          <form onSubmit={savePin} style={{marginTop:14,display:'flex',flexDirection:'column',gap:10}}>
            {hasPin && (
              <div>
                <label className="form-label">Current PIN</label>
                <input className="form-control" type="password" inputMode="numeric" maxLength={6} placeholder="Enter current PIN" value={curPin} onChange={e=>setCurPin(e.target.value)} />
              </div>
            )}
            <div>
              <label className="form-label">New PIN (4–6 digits)</label>
              <input className="form-control" type="password" inputMode="numeric" maxLength={6} placeholder="New PIN" value={newPin} onChange={e=>setNewPin(e.target.value)} />
            </div>
            <div>
              <label className="form-label">Confirm New PIN</label>
              <input className="form-control" type="password" inputMode="numeric" maxLength={6} placeholder="Confirm PIN" value={confPin} onChange={e=>setConfPin(e.target.value)} />
            </div>
            {pinMsg && <div style={{color:'var(--red)',fontSize:13,fontWeight:600}}>{pinMsg}</div>}
            <div style={{display:'flex',gap:10}}>
              <button type="submit" className="btn btn-primary" style={{flex:1}}>Save PIN</button>
              <button type="button" className="btn btn-ghost" onClick={() => { setShowPinForm(false); setPinMsg(''); }}>Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

const BackIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>;
