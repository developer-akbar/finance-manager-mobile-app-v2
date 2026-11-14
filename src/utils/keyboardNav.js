/**
 * keyboardNav.js
 *
 * Shared keyboard navigation utility for autocomplete dropdowns and suggestion lists:
 * - ArrowDown moves selection down (clamped at list.length - 1)
 * - ArrowUp moves selection up (clamped at 0)
 * - Enter selects highlighted item (or calls onDefaultEnter if provided)
 * - Escape closes suggestion list and stops event propagation
 */

export function handleSuggestionKeyDown({
  e,
  suggestions = [],
  selectedIndex = -1,
  setSelectedIndex,
  onSelect,
  onClose,
  onDefaultEnter,
}) {
  if (suggestions && suggestions.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, suggestions.length - 1));
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
      return true;
    }
    if (e.key === 'Enter') {
      if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
        e.preventDefault();
        onSelect(suggestions[selectedIndex]);
        return true;
      }
      if (onDefaultEnter) {
        e.preventDefault();
        onDefaultEnter();
        return true;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (onClose) onClose();
      setSelectedIndex(-1);
      return true;
    }
  } else {
    if (e.key === 'Enter' && onDefaultEnter) {
      e.preventDefault();
      onDefaultEnter();
      return true;
    }
  }
  return false;
}

