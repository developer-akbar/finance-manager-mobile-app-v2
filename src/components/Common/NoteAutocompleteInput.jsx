import React, { useState, useRef, useEffect, useMemo } from 'react';
import { getNoteSuggestions } from '../../utils/noteSuggestions.js';

/**
 * Reusable Note Autocomplete Input component for FinMan forms
 */
export default function NoteAutocompleteInput({
  value = '',
  onChange,
  transactions = [],
  placeholder = 'Add a note...',
  className = 'form-input',
  style = {},
  onKeyDown,
  limit = 8,
  disabled = false,
  autoFocus = false
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  const suggestions = useMemo(() => {
    if (!isOpen) return [];
    return getNoteSuggestions(transactions, value, limit);
  }, [transactions, value, isOpen, limit]);

  // Click outside listener
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
        setSelectedIndex(-1);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, []);

  const handleSelect = (sug) => {
    onChange(sug);
    setIsOpen(false);
    setSelectedIndex(-1);
  };

  const handleKeyDownInternal = (e) => {
    if (isOpen && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % suggestions.length);
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + suggestions.length) % suggestions.length);
        return;
      } else if (e.key === 'Enter' && selectedIndex >= 0 && selectedIndex < suggestions.length) {
        e.preventDefault();
        handleSelect(suggestions[selectedIndex]);
        return;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
        setSelectedIndex(-1);
        return;
      }
    }

    if (onKeyDown) {
      onKeyDown(e);
    }
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <input
        ref={inputRef}
        type="text"
        className={className}
        style={{ width: '100%', ...style }}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        onChange={e => {
          onChange(e.target.value);
          setIsOpen(true);
          setSelectedIndex(-1);
        }}
        onFocus={() => {
          setIsOpen(true);
          setSelectedIndex(-1);
        }}
        onKeyDown={handleKeyDownInternal}
      />
      {value && !disabled && (
        <button
          type="button"
          onMouseDown={e => {
            e.preventDefault();
            onChange('');
            setIsOpen(false);
            setSelectedIndex(-1);
          }}
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: '0.8rem',
            lineHeight: 1,
            padding: '4px',
            borderRadius: '50%',
            zIndex: 2
          }}
          title="Clear note"
        >
          ✕
        </button>
      )}

      {isOpen && suggestions.length > 0 && (
        <div
          className="note-sug-list"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '100%',
            zIndex: 1000,
            maxHeight: 180,
            overflowY: 'auto',
            background: 'var(--bg-card2)',
            border: '1px solid var(--border)',
            borderRadius: '0 0 var(--r-md) var(--r-md)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)'
          }}
        >
          {suggestions.map((sug, idx) => (
            <div
              key={sug}
              className={`note-sug-item ${idx === selectedIndex ? 'selected' : ''}`}
              style={{
                padding: '8px 12px',
                fontSize: '0.8rem',
                cursor: 'pointer',
                background: idx === selectedIndex ? 'var(--bg-hover)' : 'transparent',
                color: 'var(--text-primary)',
                borderBottom: idx < suggestions.length - 1 ? '1px solid var(--border-light)' : 'none'
              }}
              onMouseEnter={() => setSelectedIndex(idx)}
              onMouseDown={e => {
                e.preventDefault();
                handleSelect(sug);
              }}
            >
              {sug}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
