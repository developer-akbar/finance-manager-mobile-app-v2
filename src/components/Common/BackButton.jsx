import React from 'react';

/**
 * Standard FinMan BackButton component.
 *
 * Provides a standardized rounded-square back navigation button across all screens:
 * - Rounded-square container (34px x 34px, 10px border-radius)
 * - Centered left-chevron icon (<path d="M15 18l-6-6 6-6" />)
 * - Theme-aware subtle background, border, hover, active, and focus-visible states
 * - Fully accessible with customizable label/title
 */
export default function BackButton({
  onClick,
  label = 'Go back',
  title,
  className = '',
  disabled = false,
  style,
  ...restProps
}) {
  const displayTitle = title || label;

  return (
    <button
      type="button"
      className={`back-btn ${className}`.trim()}
      onClick={onClick}
      aria-label={label}
      title={displayTitle}
      disabled={disabled}
      style={style}
      {...restProps}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        width="18"
        height="18"
        aria-hidden="true"
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>
  );
}

