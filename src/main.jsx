import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles/globals.css';

// Global bypass for native OS copy/paste selection tooltips on touch screens,
// while preserving the "auto-replace on focus" numeric input typing experience.
if (typeof window !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
      if (isTouch) {
        e.target.dataset.justFocused = 'true';
      }
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      if (e.target.dataset.justFocused === 'true') {
        e.target.dataset.justFocused = 'false';
        const isPrintable = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
        if (isPrintable) {
          const prototype = e.target.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(e.target, '');
            const ev = new Event('input', { bubbles: true });
            e.target.dispatchEvent(ev);
          }
        }
      }
    }
  }, true);
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
);
