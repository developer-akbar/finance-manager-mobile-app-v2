import React, { useState, useEffect, useRef, useMemo } from 'react';
import './CalendarDatePicker.css';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const WEEKDAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/**
 * Standard Calendar Date Picker Popover for FinMan.
 *
 * Supports:
 * - Direct month and year navigation via previous/next arrows and dropdown selectors.
 * - Jump-to-Today quick shortcut.
 * - Selecting any valid date across months and years.
 * - Distinct, accessible highlights for Today vs Selected Date.
 * - Outside click and Escape key dismissal.
 * - Theme-aware light and dark styling matching FinMan design system.
 */
export default function CalendarDatePicker({
  isOpen,
  initialDate,
  selectedDate,
  onSelectDate,
  onClose
}) {
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  // Parse initial viewing date
  const parsedInitial = useMemo(() => {
    if (!initialDate) return new Date();
    if (initialDate instanceof Date && !isNaN(initialDate.getTime())) return initialDate;
    const d = new Date(initialDate);
    return isNaN(d.getTime()) ? new Date() : d;
  }, [initialDate]);

  // Parse selected date for visual matching
  const parsedSelected = useMemo(() => {
    if (!selectedDate) return null;
    if (selectedDate instanceof Date && !isNaN(selectedDate.getTime())) {
      const d = new Date(selectedDate);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    // Handle DD/MM/YYYY or YYYY-MM-DD
    const s = String(selectedDate).trim();
    const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (dmy) {
      return new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      d.setHours(0, 0, 0, 0);
      return d;
    }
    return null;
  }, [selectedDate]);

  const [calMonth, setCalMonth] = useState(parsedInitial.getMonth());
  const [calYear, setCalYear] = useState(parsedInitial.getFullYear());
  const dialogRef = useRef(null);

  // Sync state whenever popup opens with a new initialDate
  useEffect(() => {
    if (isOpen) {
      setCalMonth(parsedInitial.getMonth());
      setCalYear(parsedInitial.getFullYear());
    }
  }, [isOpen, parsedInitial]);

  // Handle Escape key to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Month navigation helpers
  const handlePrevMonth = () => {
    if (calMonth === 0) {
      setCalMonth(11);
      setCalYear(y => y - 1);
    } else {
      setCalMonth(m => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (calMonth === 11) {
      setCalMonth(0);
      setCalYear(y => y + 1);
    } else {
      setCalMonth(m => m + 1);
    }
  };

  const handleJumpToday = () => {
    setCalMonth(today.getMonth());
    setCalYear(today.getFullYear());
  };

  const handleSelectDay = (date) => {
    if (onSelectDate) {
      onSelectDate(date);
    }
    if (onClose) {
      onClose();
    }
  };

  // Generate Year options (current year - 10 to current year + 10)
  const yearOptions = useMemo(() => {
    const curYear = today.getFullYear();
    const years = [];
    for (let y = curYear - 12; y <= curYear + 10; y++) {
      years.push(y);
    }
    return years;
  }, [today]);

  // Build 42-day calendar matrix (6 weeks)
  const calendarDays = useMemo(() => {
    const days = [];
    const firstDayOfWeek = new Date(calYear, calMonth, 1).getDay(); // 0 = Sun
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(calYear, calMonth, 0).getDate();

    // Previous month filler days
    for (let i = firstDayOfWeek - 1; i >= 0; i--) {
      const dNum = daysInPrevMonth - i;
      const dObj = new Date(calYear, calMonth - 1, dNum);
      days.push({
        dayNumber: dNum,
        date: dObj,
        isCurrentMonth: false,
        key: `prev-${dNum}`
      });
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      const dObj = new Date(calYear, calMonth, d);
      days.push({
        dayNumber: d,
        date: dObj,
        isCurrentMonth: true,
        key: `cur-${d}`
      });
    }

    // Next month filler days (complete grid to multiple of 7)
    const trailingDays = (7 - (days.length % 7)) % 7;
    for (let d = 1; d <= trailingDays; d++) {
      const dObj = new Date(calYear, calMonth + 1, d);
      days.push({
        dayNumber: d,
        date: dObj,
        isCurrentMonth: false,
        key: `next-${d}`
      });
    }

    return days;
  }, [calYear, calMonth]);

  if (!isOpen) return null;

  return (
    <div className="cal-popover-root" role="dialog" aria-modal="true" aria-label="Choose Date">
      {/* Click-outside backdrop */}
      <div className="cal-popover-backdrop" onClick={onClose} aria-hidden="true" />

      {/* Popover container */}
      <div className="cal-popover-card" ref={dialogRef} onClick={e => e.stopPropagation()}>
        {/* Top Header Controls: Prev, Month Select, Year Select, Next */}
        <div className="cal-header-row">
          <button
            type="button"
            className="cal-nav-arrow"
            onClick={handlePrevMonth}
            aria-label="Previous month"
            title="Previous month"
          >
            ‹
          </button>

          <div className="cal-selectors">
            <select
              className="cal-select cal-select-month"
              value={calMonth}
              onChange={e => setCalMonth(Number(e.target.value))}
              aria-label="Select month"
            >
              {MONTH_NAMES.map((name, idx) => (
                <option key={idx} value={idx}>{name}</option>
              ))}
            </select>

            <select
              className="cal-select cal-select-year"
              value={calYear}
              onChange={e => setCalYear(Number(e.target.value))}
              aria-label="Select year"
            >
              {yearOptions.map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="cal-nav-arrow"
            onClick={handleNextMonth}
            aria-label="Next month"
            title="Next month"
          >
            ›
          </button>
        </div>

        {/* Day-of-Week Names */}
        <div className="cal-weekdays-row" aria-hidden="true">
          {WEEKDAY_NAMES.map(wd => (
            <div key={wd} className="cal-weekday-cell">{wd}</div>
          ))}
        </div>

        {/* Days Grid */}
        <div className="cal-days-grid" role="grid">
          {calendarDays.map(({ dayNumber, date, isCurrentMonth, key }) => {
            const isToday = date.getTime() === today.getTime();
            const isSelected = parsedSelected && date.getTime() === parsedSelected.getTime();

            const cellClasses = [
              'cal-day-btn',
              !isCurrentMonth ? 'cal-day-other' : '',
              isToday ? 'cal-day-today' : '',
              isSelected ? 'cal-day-selected' : ''
            ].filter(Boolean).join(' ');

            const dateLabel = date.toLocaleDateString('en-IN', {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              year: 'numeric'
            });

            return (
              <button
                key={key}
                type="button"
                className={cellClasses}
                onClick={() => handleSelectDay(date)}
                aria-label={dateLabel}
                aria-current={isToday ? 'date' : undefined}
                aria-selected={isSelected ? 'true' : 'false'}
                title={dateLabel}
              >
                <span className="cal-day-num">{dayNumber}</span>
                {isToday && !isSelected && <span className="cal-today-dot" aria-hidden="true" />}
              </button>
            );
          })}
        </div>

        {/* Footer shortcuts: Jump to Today & Close */}
        <div className="cal-footer-row">
          <button
            type="button"
            className="cal-footer-today-btn"
            onClick={() => handleSelectDay(today)}
            title="Select today"
          >
            Select Today
          </button>

          <button
            type="button"
            className="cal-footer-close-btn"
            onClick={onClose}
            aria-label="Close calendar"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

