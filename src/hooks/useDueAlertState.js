import { useState, useEffect, useCallback } from 'react';

export const PAID_ALERT_STORAGE = 'finman-paid-due-alerts';
export const DISMISS_ALERT_STORAGE = 'finman-dismissed-due-alerts';
export const DUE_ALERTS_CHANGED_EVENT = 'finman-due-alerts-changed';

export function getStoredPaidAlerts() {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(PAID_ALERT_STORAGE);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) {
    return new Set();
  }
}

export function getStoredDismissedAlerts() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(DISMISS_ALERT_STORAGE);
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) {
    return {};
  }
}

export function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

export function useDueAlertState() {
  const [paidDueAlerts, setPaidDueAlerts] = useState(getStoredPaidAlerts);
  const [dismissedDueAlerts, setDismissedDueAlerts] = useState(getStoredDismissedAlerts);
  const todayKey = getTodayKey();

  const syncFromStorage = useCallback(() => {
    setPaidDueAlerts(getStoredPaidAlerts());
    setDismissedDueAlerts(getStoredDismissedAlerts());
  }, []);

  useEffect(() => {
    const handleCustomEvent = () => syncFromStorage();
    const handleStorageEvent = (e) => {
      if (e.key === PAID_ALERT_STORAGE || e.key === DISMISS_ALERT_STORAGE) {
        syncFromStorage();
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener(DUE_ALERTS_CHANGED_EVENT, handleCustomEvent);
      window.addEventListener('storage', handleStorageEvent);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener(DUE_ALERTS_CHANGED_EVENT, handleCustomEvent);
        window.removeEventListener('storage', handleStorageEvent);
      }
    };
  }, [syncFromStorage]);

  const notifyChange = () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(DUE_ALERTS_CHANGED_EVENT));
    }
  };

  const markPaid = useCallback((acctName) => {
    const currentPaid = getStoredPaidAlerts();
    currentPaid.add(acctName);
    const currentDismissed = getStoredDismissedAlerts();
    delete currentDismissed[acctName];

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(PAID_ALERT_STORAGE, JSON.stringify([...currentPaid]));
        localStorage.setItem(DISMISS_ALERT_STORAGE, JSON.stringify(currentDismissed));
      } catch (e) {
        // ignore storage write failure
      }
    }

    setPaidDueAlerts(new Set(currentPaid));
    setDismissedDueAlerts({ ...currentDismissed });
    notifyChange();
  }, []);

  const markDismissed = useCallback((acctName) => {
    const currentDismissed = getStoredDismissedAlerts();
    currentDismissed[acctName] = getTodayKey();

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(DISMISS_ALERT_STORAGE, JSON.stringify(currentDismissed));
      } catch (e) {
        // ignore storage write failure
      }
    }

    setDismissedDueAlerts({ ...currentDismissed });
    notifyChange();
  }, []);

  return {
    paidDueAlerts,
    dismissedDueAlerts,
    todayKey,
    markPaid,
    markDismissed,
  };
}
