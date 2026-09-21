/**
 * Global Note Suggestions Engine
 * 
 * Provides unified, clean, user-entered Note autocomplete across FinMan.
 * Extracts unique user notes from transaction history, deduplicates case-insensitively,
 * ranks by frequency & recency, and excludes system metadata/tags.
 */

export const stripNoteSuffixes = (note) => {
  if (!note) return '';
  return note
    .replace(/\s*\(\d+\/\d+\)\s*$/, '') // strip instalment "(1/3)"
    .replace(/\s*\[.*?\]\s*$/, '')       // strip bracketed metadata
    .trim();
};

export const isSystemMetadataNote = (note) => {
  if (!note) return true;
  const n = note.trim();
  if (!n) return true;
  if (n.startsWith('#')) return true;
  // System descriptions contain quantity traces like "Used 1 pcs..." or "(bought on ...)"
  if (/^(?:Used|Lent|Instalment Use)\s+\d+(?:\.\d+)?\s*(?:pcs|pc|kg|g|ml|l|box|pack)/i.test(n)) return true;
  if (/\(bought on [^\)]+\)/i.test(n)) return true;
  if (n.toLowerCase() === 'in stock' || n.toLowerCase() === 'in_stock' || n.toLowerCase() === 'consumed') return true;
  if (n.toLowerCase().includes('stock_ref_') || n.toLowerCase().includes('reconciliation adjustment')) return true;
  return false;
};

/**
 * Extract deduplicated, frequency-ranked user notes from transactions list
 */
export const getCleanUserNotes = (transactions = []) => {
  const noteStats = new Map(); // lowerKey -> { originalText, count, lastIndex }

  for (let i = 0; i < transactions.length; i++) {
    const rawNote = transactions[i]?.Note || transactions[i]?.note || '';
    const clean = stripNoteSuffixes(rawNote);
    if (!clean || isSystemMetadataNote(clean)) continue;

    const lower = clean.toLowerCase();
    if (noteStats.has(lower)) {
      const stat = noteStats.get(lower);
      stat.count += 1;
      // Preserve the most well-cased version (prefer title/sentence case over all lowercase)
      if (clean !== clean.toLowerCase() && stat.originalText === stat.originalText.toLowerCase()) {
        stat.originalText = clean;
      }
    } else {
      noteStats.set(lower, { originalText: clean, count: 1, firstSeenIndex: i });
    }
  }

  // Sort by count DESC, then recency (firstSeenIndex ASC)
  return Array.from(noteStats.values())
    .sort((a, b) => b.count - a.count || a.firstSeenIndex - b.firstSeenIndex)
    .map(s => s.originalText);
};

/**
 * Filter note suggestions based on user query
 */
export const getNoteSuggestions = (transactions = [], query = '', limit = 8) => {
  const allNotes = getCleanUserNotes(transactions);
  const q = (query || '').trim().toLowerCase();
  if (!q) {
    return allNotes.slice(0, limit);
  }
  return allNotes.filter(n => n.toLowerCase().includes(q)).slice(0, limit);
};
