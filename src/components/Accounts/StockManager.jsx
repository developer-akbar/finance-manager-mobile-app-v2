import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, normalizeSuggestionQuery } from '../../utils/format.js';
import { calculateLifetimePurchaseSavings } from '../../utils/stockInventorySavings.js';
import {
  extractNormalizedBatchesFromTransactions,
  groupBatchesByProduct,
  getCanonicalProductName,
  parseStockLine,
  DEFAULT_STOCK_CATEGORIES
} from '../../utils/stockInventoryNormalization.js';
import { aggregateProductPhysicalQuantities } from '../../utils/stockPhysicalQuantity.js';
import {
  getInventoryItems,
  addInventoryPurchase,
  consumeInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  syncStockFromPastTransactions
} from '../../database/inventory.js';
import NoteAutocompleteInput from '../Common/NoteAutocompleteInput.jsx';
import StockActivityDrawer from './StockActivityDrawer.jsx';
import './StockManager.css';

const getEmoji = (name) => {
  const n = (name || '').toLowerCase();
  if (n.includes('milk') || n.includes('cheese') || n.includes('dairy') || n.includes('butter') || n.includes('paneer')) return '🥛';
  if (n.includes('egg')) return '🥚';
  if (n.includes('apple') || n.includes('banana') || n.includes('mango') || n.includes('fruit') || n.includes('orange')) return '🍎';
  if (n.includes('onion') || n.includes('tomato') || n.includes('potato') || n.includes('garlic') || n.includes('veg')) return '🥕';
  if (n.includes('chicken') || n.includes('meat') || n.includes('fish') || n.includes('mutton')) return '🍗';
  if (n.includes('bread') || n.includes('bun') || n.includes('roti') || n.includes('atta')) return '🍞';
  if (n.includes('rice') || n.includes('dal') || n.includes('wheat') || n.includes('grain')) return '🌾';
  if (n.includes('oil') || n.includes('ghee')) return '🛢️';
  if (n.includes('biscuit') || n.includes('cookie') || n.includes('snack') || n.includes('chips')) return '🍪';
  if (n.includes('chocolate') || n.includes('sweet') || n.includes('sugar') || n.includes('honey')) return '🍬';
  if (n.includes('salt') || n.includes('pepper') || n.includes('masala') || n.includes('spice')) return '🧂';
  if (n.includes('shampoo') || n.includes('soap') || n.includes('wash') || n.includes('paste')) return '🧼';
  return '🥫';
};

const extractPersonName = (rawNote) => {
  if (!rawNote) return '';
  let s = rawNote.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
  s = s.replace(/^(to\s*:?|from\s*:?|lend\s*to\s*:?|lend\s*from\s*:?|borrow\s*from\s*:?|given\s*to\s*:?|received\s*from\s*:?|return\s*from\s*:?|repay\s*to\s*:?|paid\s*to\s*:?)\s+/i, '');
  s = s.replace(/\s+(return|settlement|repayment|lent|borrowed|advance)$/i, '');
  return s.trim();
};

const formatFraction = (val) => {
  if (val === 0 || !val) return '0';
  const integerPart = Math.floor(val);
  const decimalPart = val - integerPart;

  if (decimalPart < 0.005) {
    return String(integerPart);
  }
  if (Math.abs(decimalPart - 1) < 0.005) {
    return String(integerPart + 1);
  }

  const epsilon = 0.01;
  const fractions = [
    { dec: 0.5, frac: '1/2' },
    { dec: 0.25, frac: '1/4' },
    { dec: 0.75, frac: '3/4' },
    { dec: 1 / 3, frac: '1/3' },
    { dec: 2 / 3, frac: '2/3' },
    { dec: 1 / 8, frac: '1/8' },
    { dec: 3 / 8, frac: '3/8' },
    { dec: 5 / 8, frac: '5/8' },
    { dec: 7 / 8, frac: '7/8' },
    { dec: 0.2, frac: '1/5' },
    { dec: 0.4, frac: '2/5' },
    { dec: 0.6, frac: '3/5' },
    { dec: 0.8, frac: '4/5' },
    { dec: 1 / 6, frac: '1/6' },
    { dec: 5 / 6, frac: '5/6' },
  ];

  for (const item of fractions) {
    if (Math.abs(decimalPart - item.dec) < epsilon) {
      return integerPart > 0 ? `${integerPart} ${item.frac}` : item.frac;
    }
  }

  return String(parseFloat(val.toFixed(3)));
};

const formatPriceVal = (val) => {
  if (val === null || val === undefined || isNaN(val) || val === '') return '0';
  const num = Number(val);
  return (num % 1 !== 0) ? num.toFixed(2) : String(Math.round(num));
};

const cleanItemName = (rawName) => {
  if (!rawName) return '';
  let name = rawName.trim();
  name = name.replace(/\s+([\d\.]+)\s*(kg|g|ml|l|pcs|pc|box|pack|bottle|oz|m)s?(\s*[\*x]\s*\d+)?\s*$/i, '');
  return name.trim();
};

const normalizeUnit = (u) => {
  if (!u) return 'pcs';
  const low = u.toLowerCase().trim();
  if (low === 'l' || low === 'litre' || low === 'litres' || low === 'liter' || low === 'liters') return 'litre';
  if (low === 'kg' || low === 'kilogram' || low === 'kilograms') return 'kg';
  if (low === 'g' || low === 'gram' || low === 'grams') return 'g';
  if (low === 'ml' || low === 'milliliter' || low === 'milliliters') return 'ml';
  if (low === 'pcs' || low === 'pc' || low === 'piece' || low === 'pieces') return 'pcs';
  if (low === 'box' || low === 'boxes') return 'box';
  if (low === 'packet' || low === 'packets' || low === 'pkt') return 'packet';
  return low;
};

import { createEmptyPurchaseItem, getItemCalculations } from '../../utils/stockCalculations.js';
export { createEmptyPurchaseItem, getItemCalculations };

export default function StockManager({ onBack, backInterceptRef }) {
  const { state, load, updateTransaction } = useApp();
  const { accounts, categories, transactions } = state;

  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('in_stock'); // 'in_stock', 'out_of_stock', 'all'
  const [search, setSearch] = useState('');

  // Product Detail View state
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState('all');
  const [activeActivityProduct, setActiveActivityProduct] = useState(null);
  const [activeActivityBatchId, setActiveActivityBatchId] = useState(null);

  const [popup, setPopup] = useState(null);

  const showAppAlert = (message, onConfirm = null) => {
    setPopup({ type: 'alert', message, onConfirm });
  };

  const showAppConfirm = (message, onConfirm, onCancel = null) => {
    setPopup({ type: 'confirm', message, onConfirm, onCancel });
  };

  // In-flight execution guards
  const isConsumingRef = useRef(false);
  const isPurchasingRef = useRef(false);
  const isEditingRef = useRef(false);

  // Async saving states
  const [isSavingConsume, setIsSavingConsume] = useState(false);
  const [isSavingPurchase, setIsSavingPurchase] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Inline edit state
  const [editingBatchId, setEditingBatchId] = useState(null);
  const [editFormData, setEditFormData] = useState({});
  const [activeStoreEditSug, setActiveStoreEditSug] = useState(false);
  const [activeEditItemSug, setActiveEditItemSug] = useState(false);

  // Suggestions active index states
  const [activeItemSugIdx, setActiveItemSugIdx] = useState(null);
  const [activeStoreSugIdx, setActiveStoreSugIdx] = useState(null);
  const [activeLendSug, setActiveLendSug] = useState(false);

  // Consumption states
  const [consumingItemId, setConsumingItemId] = useState(null);
  const [consumingBatch, setConsumingBatch] = useState(null);
  const [consumingItemName, setConsumingItemName] = useState('');
  const [consumingItemBatchDate, setConsumingItemBatchDate] = useState('');
  const [consumeQty, setConsumeQty] = useState('');
  const [consumeUserNote, setConsumeUserNote] = useState('');
  const [consumeDescription, setConsumeDescription] = useState('');
  const [consumeDate, setConsumeDate] = useState(new Date().toISOString().split('T')[0]);
  const [consumeTime, setConsumeTime] = useState('');
  const [consumeUnitMode, setConsumeUnitMode] = useState('pack'); // 'pack' or 'sub'
  const [consumeCategory, setConsumeCategory] = useState('To Home');
  const [consumeSubcategory, setConsumeSubcategory] = useState('Groceries');
  const [usageType, setUsageType] = useState('consume'); // 'consume' or 'lend' or 'instalment'
  const [instalmentMonths, setInstalmentMonths] = useState('3');
  const [instalmentDays, setInstalmentDays] = useState('90');
  const [instalmentInputMode, setInstalmentInputMode] = useState('months'); // 'months' or 'days'
  const [instalmentScheduleMode, setInstalmentScheduleMode] = useState('on_date'); // 'on_date' or 'start_of_month'
  const [personName, setPersonName] = useState('');
  const [consumeError, setConsumeError] = useState('');

  // Purchase modal states
  const [showPurchaseModal, setShowPurchaseModal] = useState(false);
  const [showAccountPicker, setShowAccountPicker] = useState(false);
  const [accountSearchQuery, setAccountSearchQuery] = useState('');
  const [purchaseFrom, setPurchaseFrom] = useState('');
  const [purchaseSubAccount, setPurchaseSubAccount] = useState('');
  const [showSubAccountPicker, setShowSubAccountPicker] = useState(false);
  const accountPickerRef = useRef(null);
  const subAccountPickerRef = useRef(null);

  useEffect(() => {
    if (!showAccountPicker && !showSubAccountPicker) return;
    const handleClickOutside = (e) => {
      const inAcct = accountPickerRef.current && accountPickerRef.current.contains(e.target);
      const inSub = subAccountPickerRef.current && subAccountPickerRef.current.contains(e.target);
      if (!inAcct && !inSub) {
        setShowAccountPicker(false);
        setShowSubAccountPicker(false);
        setAccountSearchQuery('');
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          if (accountPickerRef.current?.contains(document.activeElement) || subAccountPickerRef.current?.contains(document.activeElement)) {
            document.activeElement.blur();
          }
        }
      }
    };
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('touchstart', handleClickOutside, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('touchstart', handleClickOutside, true);
    };
  }, [showAccountPicker, showSubAccountPicker]);

  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().split('T')[0]);
  const [purchaseTime, setPurchaseTime] = useState(new Date().toLocaleTimeString('en-IN', { hour12: false }).slice(0, 5));
  const [purchaseNote, setPurchaseNote] = useState('in stock');
  const [purchaseItems, setPurchaseItems] = useState([createEmptyPurchaseItem()]);
  const [errors, setErrors] = useState({});
  const [syncing, setSyncing] = useState(false);

  // Derive all normalized historical batches from transactions
  const allNormalizedBatches = useMemo(() => {
    return extractNormalizedBatchesFromTransactions(transactions || []);
  }, [transactions]);

  // Derive canonical product hierarchy
  const canonicalProducts = useMemo(() => {
    return groupBatchesByProduct(allNormalizedBatches);
  }, [allNormalizedBatches]);

  // Overall stats
  const stats = useMemo(() => {
    let availableValue = 0;
    allNormalizedBatches.forEach(b => {
      availableValue += b.remainingQty * b.unitPrice;
    });

    const savingsResult = calculateLifetimePurchaseSavings(transactions);

    return {
      totalPurchased: savingsResult.totalPurchased,
      totalSaved: savingsResult.totalSaved,
      savedPct: savingsResult.savedPct,
      savedPercentage: savingsResult.savedPercentage,
      availableValue
    };
  }, [allNormalizedBatches, transactions]);

  // Helper to resolve an individual batch's store / source
  const getBatchSource = useCallback((batch) => {
    if (!batch) return '';
    if (batch.source && batch.source.trim()) return batch.source.trim();
    if (batch.notes && batch.notes.trim()) return batch.notes.trim();

    // Direct ID match from SQLite / IDB inventory table items
    const directMatch = (items || []).find(i => i.id === batch.id || i.id === batch.batchId);
    if (directMatch && directMatch.notes && directMatch.notes.trim()) return directMatch.notes.trim();

    const targetName = (batch.cleanedName || batch.name || batch.canonicalProduct || '').toLowerCase().trim();
    const exactMatch = (items || []).find(i =>
      (i.name || '').toLowerCase().trim() === targetName &&
      i.purchased_date === batch.purchasedDate &&
      Number(i.original_qty || i.pack_qty || 1) === Number(batch.purchasedQty || batch.original_qty || 1) &&
      String(i.sub_qty || 1) === String(batch.sub_qty || 1) &&
      (i.sub_unit || '').toLowerCase().trim() === (batch.sub_unit || '').toLowerCase().trim() &&
      i.notes && i.notes.trim()
    );
    if (exactMatch && exactMatch.notes && exactMatch.notes.trim()) return exactMatch.notes.trim();

    // Fallback: Check if the underlying transaction had a store or note
    const txnNote = batch.originalTxn?.Note || batch.originalTxn?.note || '';
    if (txnNote && txnNote.trim() && txnNote.toLowerCase() !== 'in stock') return txnNote.trim();

    return '';
  }, [items]);

  // Filtered products list for main catalog
  const filteredProducts = useMemo(() => {
    return canonicalProducts.filter(p => {
      if (filter === 'in_stock' && p.totalRemainingQty <= 0) return false;
      if (filter === 'out_of_stock' && p.totalRemainingQty > 0) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const matchName = p.productName.toLowerCase().includes(q);
        const matchCategory = (p.category || '').toLowerCase().includes(q);
        const matchBrand = (p.brand || '').toLowerCase().includes(q);
        const matchVariant = p.variantList.some(v => v.variant.toLowerCase().includes(q));
        const matchStore = p.batches.some(b => (getBatchSource(b) || '').toLowerCase().includes(q));
        return matchName || matchCategory || matchBrand || matchVariant || matchStore;
      }
      return true;
    });
  }, [canonicalProducts, filter, search, getBatchSource]);

  // Active product for detail view
  const activeProductData = useMemo(() => {
    if (!selectedProduct) return null;
    return canonicalProducts.find(p => p.productName === selectedProduct) || null;
  }, [canonicalProducts, selectedProduct]);

  // Physical quantity aggregation for active product
  const activeProductPhysical = useMemo(() => {
    if (!activeProductData || !activeProductData.batches) return null;
    return aggregateProductPhysicalQuantities(activeProductData.batches);
  }, [activeProductData]);

  // Batches for active product filtered by variant
  const activeProductBatches = useMemo(() => {
    if (!activeProductData) return [];
    if (selectedVariant === 'all') return activeProductData.batches;
    return activeProductData.batches.filter(b => b.variant === selectedVariant);
  }, [activeProductData, selectedVariant]);


  const handleExportExcel = async (mode = 'history') => {
    try {
      const XLSX = await import('xlsx');
      const dataRows = [];

      // Header row matching requested column order: Date, Brand, Variant, Source, Purchased, Item Price, MRP, Paid, Saved, Consumed, Rem. Qty, Rem. Value, Status
      dataRows.push([
        'Product', 'Date', 'Brand', 'Variant', 'Source', 'Purchased',
        'Item Price (₹)', 'MRP (₹)', 'Paid (₹)', 'Saved (₹)',
        'Consumed', 'Rem. Qty', 'Rem. Value (₹)', 'Status'
      ]);

      const batchesToExport = selectedProduct ? activeProductBatches : allNormalizedBatches;

      batchesToExport.forEach(b => {
        const remVal = (b.remainingQty || 0) * (b.unitPrice || 0);
        dataRows.push([
          b.canonicalProduct || '',
          b.purchasedDate || '',
          getBatchBrand(b) || '',
          b.variant || '',
          getBatchSource(b) || '',
          b.purchasedQty,
          Number((b.unitPrice || 0).toFixed(2)),
          Number((b.mrp || 0).toFixed(2)),
          Number((b.paid || 0).toFixed(2)),
          Number((b.savings || 0).toFixed(2)),
          b.consumedQty,
          b.remainingQty,
          Number(remVal.toFixed(2)),
          b.remainingQty > 0 ? 'In Stock' : 'Out'
        ]);
      });

      const sheetName = selectedProduct ? selectedProduct.slice(0, 31).replace(/[\\/?*[\]:]/g, '') : 'Stock History';
      const ws = XLSX.utils.aoa_to_sheet(dataRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, sheetName);

      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'binary' });
      const buf = new ArrayBuffer(wbout.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < wbout.length; i++) view[i] = wbout.charCodeAt(i) & 0xFF;

      const blob = new Blob([buf], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const exportName = selectedProduct ? `Stock_${selectedProduct.replace(/[^a-zA-Z0-9]/g, '_')}` : 'Stock-Inventory-History';
      a.download = `${exportName}_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      showAppAlert('Failed to export Excel report.');
    }
  };

  const handleSyncTransactions = () => {
    showAppConfirm(
      'This will scan past Transfer transactions to To:Stock and rebuild your inventory batches. All existing items in the current local Stock Manager screen will be reset and replaced with the parsed history. Continue?',
      async () => {
        setSyncing(true);
        try {
          const count = await syncStockFromPastTransactions();
          showAppAlert(`Successfully synchronized stock inventory! Extracted ${count} batches from your past transactions.`);
          await fetchItems();
          await load();
        } catch (err) {
          console.error(err);
          showAppAlert('Failed to synchronize stock from past transactions.');
        } finally {
          setSyncing(false);
        }
      }
    );
  };

  // Fetch inventory items on mount
  const fetchItems = async () => {
    try {
      const data = await getInventoryItems();
      setItems(data);
    } catch (err) {
      console.error('Failed to fetch stock items:', err);
    }
  };

  useEffect(() => {
    fetchItems();
  }, [transactions]);

  // Sync back button intercept
  useEffect(() => {
    if (!backInterceptRef) return;
    if (isSavingConsume || isSavingPurchase || isSavingEdit) {
      // While saving, prevent navigation or modal closing to protect in-flight DB operations
      backInterceptRef.current = () => { };
    } else if (activeActivityProduct) {
      backInterceptRef.current = () => {
        setActiveActivityProduct(null);
        setActiveActivityBatchId(null);
      };
    } else if (showPurchaseModal) {
      backInterceptRef.current = () => setShowPurchaseModal(false);
    } else if (consumingItemId) {
      backInterceptRef.current = () => {
        setConsumingItemId(null);
        setConsumeError('');
      };
    } else if (editingBatchId) {
      backInterceptRef.current = () => setEditingBatchId(null);
    } else if (selectedProduct) {
      backInterceptRef.current = () => {
        setSelectedProduct(null);
        setSelectedVariant('all');
      };
    } else {
      backInterceptRef.current = onBack;
    }
    return () => {
      if (backInterceptRef) backInterceptRef.current = onBack;
    };
  }, [showPurchaseModal, consumingItemId, editingBatchId, selectedProduct, activeActivityProduct, onBack, backInterceptRef, isSavingConsume, isSavingPurchase, isSavingEdit]);

  // Escape key handler to close popup/modals
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (isSavingConsume || isSavingPurchase || isSavingEdit) {
          return; // Prevent dismissal during saving
        }
        if (activeActivityProduct) {
          setActiveActivityProduct(null);
          setActiveActivityBatchId(null);
        } else if (showPurchaseModal) {
          setShowPurchaseModal(false);
        } else if (consumingItemId) {
          setConsumingItemId(null);
          setConsumeError('');
        } else if (editingBatchId) {
          setEditingBatchId(null);
        } else if (selectedProduct) {
          setSelectedProduct(null);
          setSelectedVariant('all');
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showPurchaseModal, consumingItemId, editingBatchId, selectedProduct, activeActivityProduct, isSavingConsume, isSavingPurchase, isSavingEdit]);

  const availableStockCategories = useMemo(() => {
    const set = new Set(DEFAULT_STOCK_CATEGORIES);
    (items || []).forEach(it => {
      if (it.category && it.category.trim()) set.add(it.category.trim());
    });
    (canonicalProducts || []).forEach(p => {
      if (p.category && p.category.trim()) set.add(p.category.trim());
    });
    return [...set];
  }, [items, canonicalProducts]);

  const existingProductLookup = useMemo(() => {
    const map = new Map();
    (items || []).forEach(it => {
      const key = (it.name || '').toLowerCase().trim();
      if (key) {
        const existing = map.get(key);
        if (!existing || (!existing.brand && it.brand) || (!existing.category && it.category)) {
          map.set(key, {
            name: it.name,
            category: it.category || existing?.category || '',
            brand: it.brand || existing?.brand || '',
            sub_qty: String(it.sub_qty || existing?.sub_qty || 1),
            sub_unit: it.sub_unit || existing?.sub_unit || 'pcs'
          });
        }
      }
    });
    (allNormalizedBatches || []).forEach(b => {
      const key = (b.canonicalProduct || b.cleanedName || b.name || '').toLowerCase().trim();
      if (key) {
        const existing = map.get(key);
        if (!existing || (!existing.brand && b.brand) || (!existing.category && b.category)) {
          map.set(key, {
            name: b.canonicalProduct || b.cleanedName || b.name,
            category: b.category || existing?.category || '',
            brand: b.brand || existing?.brand || '',
            sub_qty: String(b.sub_qty || existing?.sub_qty || 1),
            sub_unit: b.sub_unit || existing?.sub_unit || 'pcs'
          });
        }
      }
    });
    return map;
  }, [allNormalizedBatches, items]);

  // Helper to resolve an individual batch's brand
  const getBatchBrand = (batch) => {
    if (batch.brand && batch.brand.trim()) return batch.brand.trim();
    const targetName = (batch.cleanedName || batch.name || batch.canonicalProduct || '').toLowerCase().trim();

    // Direct ID match
    const directMatch = (items || []).find(i => i.id === batch.id || i.id === batch.batchId);
    if (directMatch && directMatch.brand && directMatch.brand.trim()) return directMatch.brand.trim();

    // Match by name, date, pack quantity / parts, sub_qty, sub_unit, and store/notes
    const exactMatch = (items || []).find(i =>
      (i.name || '').toLowerCase().trim() === targetName &&
      i.purchased_date === batch.purchasedDate &&
      Number(i.original_qty || i.pack_qty || 1) === Number(batch.purchasedQty || batch.original_qty || 1) &&
      String(i.sub_qty || 1) === String(batch.sub_qty || 1) &&
      (i.sub_unit || '').toLowerCase().trim() === (batch.sub_unit || '').toLowerCase().trim() &&
      (i.notes || '').trim() === (batch.source || '').trim()
    );
    if (exactMatch && exactMatch.brand && exactMatch.brand.trim()) return exactMatch.brand.trim();

    // Secondary match without notes if store is empty
    const partialMatch = (items || []).find(i =>
      (i.name || '').toLowerCase().trim() === targetName &&
      i.purchased_date === batch.purchasedDate &&
      Number(i.original_qty || i.pack_qty || 1) === Number(batch.purchasedQty || batch.original_qty || 1) &&
      String(i.sub_qty || 1) === String(batch.sub_qty || 1) &&
      (i.sub_unit || '').toLowerCase().trim() === (batch.sub_unit || '').toLowerCase().trim()
    );
    if (partialMatch && partialMatch.brand && partialMatch.brand.trim()) return partialMatch.brand.trim();

    return '';
  };

  // Resolved metadata for active product in Product History
  const activeProductMetadata = useMemo(() => {
    if (!activeProductData) return null;
    const lookup = existingProductLookup.get((activeProductData.productName || '').toLowerCase().trim());
    const category = (activeProductData.category || lookup?.category || '').trim();

    // Calculate unique non-empty brands across the currently active batches (product or filtered variant)
    const activeBatches = activeProductBatches || [];
    const uniqueBrands = [...new Set(activeBatches.map(b => getBatchBrand(b)).filter(Boolean))];

    let brandDisplay = '—';
    if (uniqueBrands.length === 1) {
      brandDisplay = uniqueBrands[0];
    } else if (uniqueBrands.length > 1) {
      brandDisplay = `${uniqueBrands.length} brands`;
    }

    let variantDisplay = '—';
    if (selectedVariant !== 'all') {
      variantDisplay = selectedVariant;
    } else {
      const vList = activeProductData.variantList || [];
      if (vList.length === 1) {
        variantDisplay = vList[0].variant;
      } else if (vList.length > 1) {
        variantDisplay = `All (${vList.length} variants)`;
      }
    }

    return {
      brand: brandDisplay,
      category: category || '—',
      variantDisplay
    };
  }, [activeProductData, activeProductBatches, existingProductLookup, selectedVariant, items]);

  // Product History Column Sorting state
  const [historySortField, setHistorySortField] = useState('date');
  const [historySortDir, setHistorySortDir] = useState('desc'); // default: newest first

  const handleSortClick = (field) => {
    if (historySortField === field) {
      setHistorySortDir(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setHistorySortField(field);
      setHistorySortDir('asc');
    }
  };

  const sortedProductBatches = useMemo(() => {
    if (!activeProductBatches || activeProductBatches.length === 0) return [];

    const indexed = activeProductBatches.map((b, idx) => ({ ...b, _origIdx: idx }));

    return indexed.sort((a, b) => {
      // 1. Keep In Stock items at top irrelevant of date or sort field
      const aInStock = (parseFloat(a.remainingQty) || 0) > 0 ? 1 : 0;
      const bInStock = (parseFloat(b.remainingQty) || 0) > 0 ? 1 : 0;
      if (aInStock !== bInStock) {
        return bInStock - aInStock; // 1 (in stock) comes before 0 (out of stock)
      }

      let comp = 0;
      switch (historySortField) {
        case 'date': {
          const dA = a.purchasedDate || '';
          const dB = b.purchasedDate || '';
          comp = dA.localeCompare(dB);
          break;
        }
        case 'brand': {
          const bA = getBatchBrand(a) || '';
          const bB = getBatchBrand(b) || '';
          if (!bA && bB) return 1;
          if (bA && !bB) return -1;
          comp = bA.localeCompare(bB, undefined, { sensitivity: 'base' });
          break;
        }
        case 'variant': {
          const vA = a.variant || '';
          const vB = b.variant || '';
          comp = vA.localeCompare(vB, undefined, { numeric: true, sensitivity: 'base' });
          break;
        }
        case 'source': {
          const sA = getBatchSource(a) || '';
          const sB = getBatchSource(b) || '';
          if (!sA && sB) return 1;
          if (sA && !sB) return -1;
          comp = sA.localeCompare(sB, undefined, { sensitivity: 'base' });
          break;
        }
        case 'purchased': {
          comp = (parseFloat(a.purchasedQty) || 0) - (parseFloat(b.purchasedQty) || 0);
          break;
        }
        case 'item_price':
        case 'unit_price': {
          comp = (parseFloat(a.unitPrice) || 0) - (parseFloat(b.unitPrice) || 0);
          break;
        }
        case 'mrp': {
          comp = (parseFloat(a.mrp) || 0) - (parseFloat(b.mrp) || 0);
          break;
        }
        case 'paid': {
          comp = (parseFloat(a.paid) || 0) - (parseFloat(b.paid) || 0);
          break;
        }
        case 'saved': {
          comp = (parseFloat(a.savings) || 0) - (parseFloat(b.savings) || 0);
          break;
        }
        case 'consumed': {
          comp = (parseFloat(a.consumedQty) || 0) - (parseFloat(b.consumedQty) || 0);
          break;
        }
        case 'remaining': {
          comp = (parseFloat(a.remainingQty) || 0) - (parseFloat(b.remainingQty) || 0);
          break;
        }
        case 'remaining_val': {
          const valA = (parseFloat(a.remainingQty) || 0) * (parseFloat(a.unitPrice) || 0);
          const valB = (parseFloat(b.remainingQty) || 0) * (parseFloat(b.unitPrice) || 0);
          comp = valA - valB;
          break;
        }
        case 'status': {
          const isAvailA = a.remainingQty > 0 ? 'In Stock' : 'Out';
          const isAvailB = b.remainingQty > 0 ? 'In Stock' : 'Out';
          comp = isAvailA.localeCompare(isAvailB);
          break;
        }
        default:
          comp = 0;
      }

      if (historySortDir === 'desc') {
        comp = -comp;
      }

      // Stable tie-breaker using original index
      if (comp === 0) {
        return a._origIdx - b._origIdx;
      }
      return comp;
    });
  }, [activeProductBatches, historySortField, historySortDir, items, getBatchBrand, getBatchSource]);

  const updatePurchaseItem = (itemId, field, value) => {
    setPurchaseItems(prev => prev.map(it => {
      if (it._id !== itemId) return it;
      const updated = { ...it, [field]: value };
      if (field === 'original_qty') {
        if (it.qty === it.original_qty || it.qty === '') {
          updated.qty = value;
        }
      }
      if (field === 'pack_qty' && (!it.original_qty || it.original_qty === it.pack_qty)) {
        updated.original_qty = value;
        if (it.qty === it.original_qty || it.qty === '') {
          updated.qty = value;
        }
      }
      return updated;
    }));
  };

  const handleSelectProductSuggestion = (itemId, prodName) => {
    const match = existingProductLookup.get(prodName.toLowerCase().trim());
    setPurchaseItems(prev => prev.map(it => {
      if (it._id !== itemId) return it;
      const updated = { ...it, name: prodName };
      if (match) {
        if (match.category) {
          if (DEFAULT_STOCK_CATEGORIES.includes(match.category)) {
            updated.category = match.category;
            updated.customCategory = '';
          } else {
            updated.category = 'Other';
            updated.customCategory = match.category;
          }
        }
        if (match.brand) updated.brand = match.brand;
        if (match.sub_qty) updated.sub_qty = match.sub_qty;
        if (match.sub_unit) updated.sub_unit = match.sub_unit;
      }
      return updated;
    }));
    setActiveItemSugIdx(null);
  };

  const getSubAccountNames = useCallback((acctNameOrObj) => {
    if (!acctNameOrObj) return [];
    let acctObj = null;
    if (typeof acctNameOrObj === 'object') {
      acctObj = acctNameOrObj;
    } else {
      acctObj = (accounts || []).find(a => (a.name || a || '').toLowerCase() === String(acctNameOrObj).toLowerCase());
    }
    if (!acctObj) return [];
    const subs = Array.isArray(acctObj.subAccounts)
      ? acctObj.subAccounts
      : (acctObj.subAccounts ? Array.from(acctObj.subAccounts) : []);
    const extracted = subs.map(s => (typeof s === 'string' ? s : (s?.name || s?.id || '')).trim()).filter(Boolean);

    const acctName = String(acctObj.name || acctObj || '').trim().toLowerCase();
    let canonicalDefaults = [];
    if (acctName === 'mutual funds tax saver') canonicalDefaults = ['Ak ETMoney'];
    else if (acctName === 'liquid mutual funds') canonicalDefaults = ['Fareeda Groww', 'Ammi Groww', 'Ak ETMoney'];
    else if (acctName === 'share market') canonicalDefaults = ['Zerodha', 'Fareeda Groww'];

    const rawList = [...extracted, ...canonicalDefaults];
    const seen = new Set();
    const unique = [];
    for (const name of rawList) {
      const key = name.trim().toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        unique.push(name.trim());
      }
    }
    return unique;
  }, [accounts]);

  const accountList = useMemo(() => {
    if (!accounts) return [];
    if (Array.isArray(accounts)) {
      return accounts
        .map(a => typeof a === 'string' ? a.trim() : (a?.name || '').trim())
        .filter(Boolean);
    }
    if (typeof accounts === 'object') {
      return Object.values(accounts)
        .map(a => typeof a === 'string' ? a.trim() : (a?.name || '').trim())
        .filter(Boolean);
    }
    return [];
  }, [accounts]);

  const recentAccountsList = useMemo(() => {
    const list = [];
    const seen = new Set();
    for (const t of (transactions || [])) {
      const acct = t.Account || t.FromAccount;
      if (acct && !seen.has(acct)) {
        seen.add(acct);
        list.push(acct);
        if (list.length >= 6) break;
      }
    }
    return list;
  }, [transactions]);

  const availablePurchaseSubAccounts = useMemo(() => {
    return getSubAccountNames(purchaseFrom);
  }, [purchaseFrom, getSubAccountNames]);

  const filteredAccountList = useMemo(() => {
    if (!accountSearchQuery.trim()) return accountList;
    const q = accountSearchQuery.toLowerCase().trim();
    return accountList.filter(a => a.toLowerCase().includes(q));
  }, [accountList, accountSearchQuery]);

  const handleSelectPurchaseAccount = (accName) => {
    setPurchaseFrom(accName);
    const subs = getSubAccountNames(accName);
    if (subs.length > 0) {
      if (!subs.includes(purchaseSubAccount)) {
        setPurchaseSubAccount(subs[0] || '');
      }
    } else {
      setPurchaseSubAccount('');
    }
    setShowAccountPicker(false);
    setAccountSearchQuery('');
  };

  const itemSuggestions = useMemo(() => {
    return [...new Set(allNormalizedBatches.map(i => i.cleanedName || i.rawName))];
  }, [allNormalizedBatches]);

  const storeSuggestions = useMemo(() => {
    const set = new Set();
    // 1. From database inventory items (where notes is specifically the saved Store Name)
    (items || []).forEach(i => {
      const s = (i.notes || '').trim();
      if (s && s !== 'Unknown' && s !== 'manual' && s.toLowerCase() !== 'in stock' && !s.startsWith('#') && s.length < 50) {
        set.add(s);
      }
    });

    // 2. From transactions where the description header explicitly records the store name
    (transactions || []).forEach(t => {
      const desc = t.Description || t.description || '';
      if (desc && (desc.toLowerCase().includes('stock available') || desc.toLowerCase().includes('stock unavailable'))) {
        const lines = desc.split('\n');
        if (lines.length > 1) {
          const first = lines[0].trim();
          if (
            first &&
            !first.toLowerCase().includes('stock available') &&
            !first.toLowerCase().includes('stock unavailable') &&
            first.toLowerCase() !== 'in stock' &&
            !first.startsWith('#') &&
            first.length < 50
          ) {
            set.add(first);
          }
        }
      }
    });

    // 3. From allNormalizedBatches where source is an actual store (and not a fallback to txn.Note)
    (allNormalizedBatches || []).forEach(b => {
      const rawTxnNote = (b.originalTxn?.Note || b.originalTxn?.note || '').trim().toLowerCase();
      const s = (b.source || '').trim();
      if (
        s &&
        s !== 'Unknown' &&
        s !== 'manual' &&
        s.toLowerCase() !== 'in stock' &&
        !s.startsWith('#') &&
        s.length < 50 &&
        (!rawTxnNote || s.toLowerCase() !== rawTxnNote)
      ) {
        set.add(s);
      }
    });

    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items, transactions, allNormalizedBatches]);

  const debtPeople = useMemo(() => {
    const names = new Set();
    (transactions || []).forEach(t => {
      const acct = (t.Account || t.FromAccount || '').toLowerCase().trim();
      const toAcct = (t.ToAccount || '').toLowerCase().trim();
      const cat = (t.Category || '').toLowerCase().trim();
      if (acct === 'lend' || toAcct === 'lend' || cat === 'lend' || acct === 'borrow' || toAcct === 'borrow' || cat === 'borrow') {
        const p = extractPersonName(t.Note);
        if (p && p.toLowerCase() !== 'unspecified') {
          names.add(p.charAt(0).toUpperCase() + p.slice(1));
        }
      }
    });
    return [...names].sort();
  }, [transactions]);

  const categoriesList = useMemo(() => {
    return Object.keys(categories || {}).sort();
  }, [categories]);

  const subcategoriesList = useMemo(() => {
    return (categories?.[consumeCategory]?.subcategories || []).filter(s => s && s !== 'Default').sort();
  }, [categories, consumeCategory]);

  const calculateDiscountedPrice = (item) => {
    const price = parseFloat(item.price) || 0;
    if (item.discountType === 'percentage') {
      const pct = parseFloat(item.discountValue) || 0;
      return Math.max(0, price * (1 - pct / 100));
    } else {
      return item.discountValue !== '' && item.discountValue !== undefined
        ? parseFloat(item.discountValue) || 0
        : price;
    }
  };

  const handleOpenConsume = (batch) => {
    const targetName = (batch.cleanedName || batch.name || '').toLowerCase();
    const dbItem = items.find(i => i.id === batch.id || i.id === batch.batchId) || items.find(i => (i.name || '').toLowerCase() === targetName);
    const itemId = batch.batchId || batch.id || (dbItem ? dbItem.id : batch.txnId);

    setConsumingItemId(itemId);
    setConsumingBatch(batch);
    setConsumingItemName(batch.cleanedName || batch.name);
    setConsumingItemBatchDate(batch.purchasedDate || '');
    setConsumeQty(String(Math.min(1, batch.remainingQty > 0 ? batch.remainingQty : 1)));
    setConsumeUserNote('');
    setConsumeDescription('');
    setConsumeDate(new Date().toISOString().split('T')[0]);
    setConsumeTime(new Date().toLocaleTimeString('en-IN', { hour12: false }).slice(0, 5));
    setConsumeUnitMode('pack');
    setConsumeCategory('To Home');
    setConsumeSubcategory('Groceries');
    setUsageType('consume');
    setPersonName('');
    setInstalmentMonths('3');
    setInstalmentDays('90');
    setInstalmentInputMode('months');
    setInstalmentScheduleMode('on_date');
    setConsumeError('');
  };

  const handleConsume = async () => {
    if (isConsumingRef.current || isSavingConsume) return;
    setConsumeError('');
    const qty = parseFloat(consumeQty);
    if (isNaN(qty) || qty <= 0) {
      setConsumeError('Please enter a valid quantity.');
      return;
    }

    if (usageType === 'lend' && !personName.trim()) {
      setConsumeError('Please enter a person name for lending.');
      return;
    }

    isConsumingRef.current = true;
    setIsSavingConsume(true);
    try {
      const instConfig = {
        inputMode: instalmentInputMode,
        months: instalmentMonths,
        days: instalmentDays,
        scheduleMode: instalmentScheduleMode
      };
      await consumeInventoryItem(
        consumingItemId,
        qty,
        consumeDate,
        consumeUnitMode === 'sub',
        consumeCategory,
        consumeSubcategory,
        usageType,
        personName,
        instConfig,
        consumeTime,
        consumeUserNote,
        consumingBatch,
        consumeDescription,
        instConfig
      );
      setConsumingItemId(null);
      setConsumingBatch(null);
      setConsumeQty('');
      setPersonName('');
      setConsumeUserNote('');
      setConsumeDescription('');
      await fetchItems();
      await load();
      showAppAlert('✓ Stock usage saved successfully.');
    } catch (err) {
      console.error(err);
      setConsumeError(err.message || 'Failed to consume item.');
    } finally {
      isConsumingRef.current = false;
      setIsSavingConsume(false);
    }
  };

  const handleOpenEdit = (batch) => {
    const originalPrice = parseFloat(batch.mrp || batch.price) || 0;
    const totalParts = parseFloat(batch.purchasedQty || batch.original_qty || 1);
    const unitPrice = parseFloat(batch.unitPrice || batch.discounted_price || 0);
    const finalPrice = totalParts * unitPrice;

    const targetName = (batch.cleanedName || batch.name || batch.canonicalProduct || '').toLowerCase().trim();
    const batchBrand = getBatchBrand(batch);
    const dbItem = (items || []).find(i => i.id === batch.id || i.id === batch.batchId);
    const lookup = existingProductLookup.get(targetName);

    const initialCat = batch.category || dbItem?.category || lookup?.category || '';
    const initialBrand = batchBrand || '';

    let discountType = 'final_price';
    let discountValue = String(finalPrice > 0 ? finalPrice : originalPrice);

    setEditingBatchId(batch.id || batch.txnId);
    setEditFormData({
      id: batch.id || batch.txnId,
      batchObj: batch,
      name: batch.cleanedName || batch.name || batch.canonicalProduct || '',
      category: DEFAULT_STOCK_CATEGORIES.includes(initialCat) ? initialCat : (initialCat ? 'Other' : 'Groceries'),
      customCategory: !DEFAULT_STOCK_CATEGORIES.includes(initialCat) && initialCat ? initialCat : '',
      brand: initialBrand || '',
      sub_qty: String(batch.sub_qty || dbItem?.sub_qty || 1),
      sub_unit: batch.sub_unit || dbItem?.sub_unit || 'pcs',
      pack_qty: String(batch.pack_qty || dbItem?.pack_qty || totalParts),
      original_qty: String(totalParts),
      qty: String(batch.remainingQty !== undefined ? batch.remainingQty : (batch.qty !== undefined ? batch.qty : totalParts)),
      price: String(originalPrice),
      discountType,
      discountValue,
      notes: getBatchSource(batch) || batch.source || batch.notes || dbItem?.notes || '',
      purchased_date: batch.purchasedDate || batch.purchased_date || ''
    });
  };

  const handleSaveEditBatch = async (batchId) => {
    if (isEditingRef.current || isSavingEdit) return;
    if (!editFormData.name.trim()) {
      showAppAlert('Item Name is required.');
      return;
    }
    if (isNaN(parseFloat(editFormData.sub_qty)) || parseFloat(editFormData.sub_qty) <= 0) {
      showAppAlert('Pack Size must be greater than 0.');
      return;
    }
    if (!editFormData.sub_unit) {
      showAppAlert('Pack Unit is required.');
      return;
    }
    if (isNaN(parseFloat(editFormData.original_qty)) || parseFloat(editFormData.original_qty) <= 0) {
      showAppAlert('Parts must be greater than 0.');
      return;
    }
    if (isNaN(parseFloat(editFormData.qty)) || parseFloat(editFormData.qty) < 0) {
      showAppAlert('Available Parts must be at least 0.');
      return;
    }
    if (isNaN(parseFloat(editFormData.price)) || parseFloat(editFormData.price) <= 0) {
      showAppAlert('Original Price must be greater than 0.');
      return;
    }

    isEditingRef.current = true;
    setIsSavingEdit(true);
    try {
      const price = parseFloat(editFormData.price) || 0;
      const discVal = parseFloat(editFormData.discountValue) || 0;
      let finalPrice = price;
      if (editFormData.discountType === 'percentage') {
        finalPrice = price * (1 - discVal / 100);
      } else if (editFormData.discountType === 'fixed') {
        finalPrice = Math.max(0, price - discVal);
      } else {
        finalPrice = editFormData.discountValue !== '' && !isNaN(parseFloat(editFormData.discountValue))
          ? parseFloat(editFormData.discountValue)
          : price;
      }
      const totalParts = parseFloat(editFormData.original_qty) || 1;
      const availableParts = editFormData.qty !== '' && !isNaN(parseFloat(editFormData.qty))
        ? parseFloat(editFormData.qty)
        : totalParts;
      const unitPrice = totalParts > 0 ? (finalPrice / totalParts) : finalPrice;
      const subQty = parseFloat(editFormData.sub_qty) || 1;
      const subUnit = editFormData.sub_unit || 'pcs';
      const packQty = parseFloat(editFormData.pack_qty) || 1;
      const finalCat = editFormData.category === 'Other' ? (editFormData.customCategory || 'Other').trim() : (editFormData.category || '').trim();
      const finalBrand = (editFormData.brand || '').trim();
      const cleanedName = cleanItemName(editFormData.name.trim());

      // 1. Update SQLite inventory table
      await updateInventoryItem(batchId, {
        name: cleanedName,
        category: finalCat,
        brand: finalBrand,
        qty: availableParts,
        unit: 'pcs',
        price: price,
        discounted_price: unitPrice,
        purchased_date: editFormData.purchased_date,
        notes: (editFormData.notes || '').trim(),
        sub_qty: subQty,
        sub_unit: subUnit,
        original_qty: totalParts,
        pack_qty: packQty,
        discount_type: editFormData.discountType,
        discount_value: discVal
      });

      // Update in-memory batch immediately so table and modal stay in sync
      if (editFormData.batchObj) {
        editFormData.batchObj.source = (editFormData.notes || '').trim();
        editFormData.batchObj.notes = (editFormData.notes || '').trim();
        editFormData.batchObj.brand = finalBrand;
      }

      // 2. Update underlying transaction in transactions table & state
      const batch = editFormData.batchObj || allNormalizedBatches.find(b => b.id === batchId || b.batchId === batchId || b.txnId === batchId);
      if (batch) {
        const txnUniqueId = batch.txnUniqueId || batch.txnId || batch.originalTxn?.ID || batch.originalTxn?._id || batch.originalTxn?.id;
        const targetTxn = (transactions || []).find(t => t.ID === txnUniqueId || t._id === txnUniqueId || t.id === txnUniqueId) || batch.originalTxn;

        if (targetTxn && updateTransaction) {
          const desc = targetTxn.Description || targetTxn.description || '';
          const lines = desc.split('\n');

          let targetLineIdx = batch.lineIdx !== undefined ? batch.lineIdx : -1;
          if (targetLineIdx < 0 || targetLineIdx >= lines.length) {
            targetLineIdx = lines.findIndex(l => l.trim() === (batch.rawLine || '').trim());
          }
          if (targetLineIdx < 0) {
            targetLineIdx = lines.findIndex(l => l.toLowerCase().includes(cleanedName.toLowerCase()) || (batch.rawName && l.toLowerCase().includes(batch.rawName.toLowerCase())));
          }

          if (targetLineIdx >= 0) {
            const sizePart = totalParts > 1 ? `${subQty}${subUnit}*${totalParts}` : `${subQty}${subUnit}`;
            const suffix = availableParts < totalParts ? `, ${availableParts}` : '';
            const statusWord = availableParts > 0 ? 'stock available' : 'stock unavailable';
            lines[targetLineIdx] = `${cleanedName} ${statusWord} ${sizePart}: ${price}: @${finalPrice}${suffix}`;

            const newDescription = lines.join('\n');

            let newTotalAmount = 0;
            lines.forEach((l, lIdx) => {
              const p = parseStockLine(l, targetTxn, lIdx);
              if (p) {
                newTotalAmount += (typeof p.paid === 'number' ? p.paid : 0);
              }
            });
            const roundedTotal = Math.round(newTotalAmount);

            const updatedTxnData = {
              ...targetTxn,
              Date: editFormData.purchased_date ? (editFormData.purchased_date.includes('-') ? editFormData.purchased_date.split('-').reverse().join('/') : editFormData.purchased_date) : targetTxn.Date,
              Description: newDescription,
              description: newDescription,
              INR: roundedTotal > 0 ? roundedTotal : (targetTxn.INR || targetTxn.Amount || 0),
              Amount: String(roundedTotal > 0 ? roundedTotal : (targetTxn.INR || targetTxn.Amount || 0)),
              Note: (editFormData.notes || '').trim() || targetTxn.Note || targetTxn.note || 'in stock'
            };

            await updateTransaction(txnUniqueId, updatedTxnData);
          }
        }
      }

      setEditingBatchId(null);
      await fetchItems();
      await load();
      showAppAlert('Batch updated successfully.');
    } catch (err) {
      console.error(err);
      showAppAlert('Failed to update batch details.');
    } finally {
      isEditingRef.current = false;
      setIsSavingEdit(false);
    }
  };

  const handleDeleteItem = (id) => {
    showAppConfirm('Delete this stock batch?', async () => {
      try {
        await deleteInventoryItem(id);
        await fetchItems();
        await load();
      } catch (err) {
        console.error(err);
        showAppAlert('Failed to delete item.');
      }
    });
  };

  const totalPurchaseSum = useMemo(() => {
    return purchaseItems.reduce((sum, item) => {
      const calcs = getItemCalculations(item);
      return sum + calcs.paidPrice;
    }, 0);
  }, [purchaseItems]);

  const totalBeforeDiscount = useMemo(() => {
    return purchaseItems.reduce((sum, item) => {
      const price = parseFloat(item.price) || 0;
      return sum + price;
    }, 0);
  }, [purchaseItems]);

  return (
    <>
      {(consumingItemId || editingBatchId) && (
        <div
          className="stock-edit-overlay"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.65)',
            backdropFilter: 'blur(4px)',
            zIndex: 990,
            pointerEvents: 'auto'
          }}
          onClick={() => {
            setConsumingItemId(null);
            setEditingBatchId(null);
          }}
        />
      )}
      <div className="stock-manager-screen" onClick={() => {
        setActiveItemSugIdx(null);
        setActiveStoreSugIdx(null);
        setActiveStoreEditSug(false);
        setActiveLendSug(false);
      }}>
        {/* Top Header */}
        <div className="page-hdr">
          <button
            className="back-btn"
            onClick={() => {
              if (activeActivityProduct) {
                setActiveActivityProduct(null);
                setActiveActivityBatchId(null);
              } else if (selectedProduct) {
                setSelectedProduct(null);
                setSelectedVariant('all');
              } else {
                onBack();
              }
            }}
            title="Back"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="page-hdr-title" style={{ flex: 1 }}>
            {selectedProduct ? selectedProduct : 'Stock Inventory'}
          </div>
          <button
            className="btn btn-sm btn-secondary"
            style={{ padding: '6px 10px', fontSize: '0.72rem', borderRadius: 8, marginRight: 6, display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={() => handleExportExcel('history')}
            title="Export Stock History to Excel"
          >
            📊 Export
          </button>
          <button
            className="btn btn-sm btn-primary"
            style={{ padding: '6px 12px', fontSize: '0.72rem', borderRadius: 8 }}
            onClick={() => {
              setShowPurchaseModal(true);
              setErrors({});
            }}
          >
            ➕ Purchase
          </button>
        </div>

        <div className="stock-manager-body">
          {/* If a product is selected, show Product Detail View (Summary Cards -> Variants -> History) */}
          {activeProductData ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Product Metadata Bar */}
              <div className="stock-prod-meta-bar">
                <div className="stock-prod-meta-chip">
                  <span className="stock-prod-meta-label">Brand:</span>
                  <span className={`stock-prod-meta-val ${activeProductMetadata?.brand === '—' ? 'empty' : ''}`}>
                    {activeProductMetadata?.brand || '—'}
                  </span>
                </div>
                <div className="stock-prod-meta-chip">
                  <span className="stock-prod-meta-label">Category:</span>
                  <span className={`stock-prod-meta-val ${activeProductMetadata?.category === '—' ? 'empty' : ''}`}>
                    {activeProductMetadata?.category || '—'}
                  </span>
                </div>
                <div className="stock-prod-meta-chip">
                  <span className="stock-prod-meta-label">Variant:</span>
                  <span className="stock-prod-meta-val variant">
                    {activeProductMetadata?.variantDisplay || '—'}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{
                    marginLeft: 'auto',
                    padding: '5px 12px',
                    fontSize: '0.74rem',
                    fontWeight: 700,
                    borderRadius: 8,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    background: 'rgba(0, 229, 160, 0.15)',
                    color: 'var(--accent)',
                    border: '1.5px solid var(--accent)',
                    cursor: 'pointer'
                  }}
                  onClick={() => {
                    setActiveActivityProduct(activeProductData.productName || selectedProduct);
                    setActiveActivityBatchId(null);
                  }}
                  title="View complete activity and transaction ledger for this product"
                >
                  📜 View Activity / History
                </button>
              </div>

              {/* Lifetime Product Summary Card */}
              <div className="stock-prod-summary-grid">
                <div className="stock-prod-stat-item">
                  <div className="stock-prod-stat-label">Purchased</div>
                  <div className="stock-prod-stat-value">
                    {formatFraction(activeProductData.totalPurchasedQty)}
                    <span style={{ fontSize: '0.72rem', fontWeight: 600, opacity: 0.8, marginLeft: 3 }}>packs</span>
                  </div>
                  {activeProductPhysical?.hasPhysicalData && activeProductPhysical.purchasedDisplay && (
                    <div className="stock-prod-stat-phys">{activeProductPhysical.purchasedDisplay}</div>
                  )}
                </div>
                <div className="stock-prod-stat-item">
                  <div className="stock-prod-stat-label">Consumed</div>
                  <div className="stock-prod-stat-value" style={{ color: 'var(--text-muted)' }}>
                    {formatFraction(activeProductData.totalConsumedQty)}
                    <span style={{ fontSize: '0.72rem', fontWeight: 600, opacity: 0.8, marginLeft: 3 }}>packs</span>
                  </div>
                  {activeProductPhysical?.hasPhysicalData && activeProductPhysical.consumedDisplay && (
                    <div className="stock-prod-stat-phys" style={{ color: 'var(--text-muted)' }}>{activeProductPhysical.consumedDisplay}</div>
                  )}
                </div>
                <div className="stock-prod-stat-item">
                  <div className="stock-prod-stat-label">Available</div>
                  <div className="stock-prod-stat-value" style={{ color: 'var(--green)' }}>
                    {formatFraction(activeProductData.totalRemainingQty)}
                    <span style={{ fontSize: '0.72rem', fontWeight: 600, opacity: 0.8, marginLeft: 3 }}>packs</span>
                  </div>
                  {activeProductPhysical?.hasPhysicalData && activeProductPhysical.remainingDisplay && (
                    <div className="stock-prod-stat-phys" style={{ color: activeProductData.totalRemainingQty > 0 ? 'var(--green)' : 'var(--text-muted)' }}>
                      {activeProductPhysical.remainingDisplay}
                    </div>
                  )}
                </div>
                <div className="stock-prod-stat-item">
                  <div className="stock-prod-stat-label">Remaining Value</div>
                  <div className="stock-prod-stat-value" style={{ color: 'var(--green)' }}>
                    {formatINR(activeProductData.availableValue, activeProductData.availableValue % 1 !== 0 ? 2 : 0)}
                  </div>
                </div>
                <div className="stock-prod-stat-item">
                  <div className="stock-prod-stat-label">Total MRP</div>
                  <div className="stock-prod-stat-value">{formatINR(activeProductData.totalMRP, activeProductData.totalMRP % 1 !== 0 ? 2 : 0)}</div>
                </div>
                <div className="stock-prod-stat-item">
                  <div className="stock-prod-stat-label">Total Paid</div>
                  <div className="stock-prod-stat-value">{formatINR(activeProductData.totalPaid, activeProductData.totalPaid % 1 !== 0 ? 2 : 0)}</div>
                </div>
                <div className="stock-prod-stat-item" title="Item-level MRP savings for this product">
                  <div className="stock-prod-stat-label">Product Saved</div>
                  <div className="stock-prod-stat-value" style={{ color: activeProductData.totalSavings < 0 ? 'var(--red, #ef4444)' : 'var(--green)' }}>
                    {activeProductData.totalSavings < 0 ? `-₹${formatPriceVal(Math.abs(activeProductData.totalSavings))}` : formatINR(activeProductData.totalSavings, activeProductData.totalSavings % 1 !== 0 ? 2 : 0)} <span style={{ fontSize: '0.62rem' }}>({activeProductData.savingsPct}%)</span>
                  </div>
                </div>
              </div>

              {/* Variant Filter Pills */}
              <div className="stock-variant-pills">
                <button
                  className={`stock-variant-pill ${selectedVariant === 'all' ? 'active' : ''}`}
                  onClick={() => setSelectedVariant('all')}
                >
                  All Variants ({activeProductData.totalPurchasedBatches})
                </button>
                {activeProductData.variantList.map(v => (
                  <button
                    key={v.variant}
                    className={`stock-variant-pill ${selectedVariant === v.variant ? 'active' : ''}`}
                    onClick={() => setSelectedVariant(v.variant)}
                  >
                    {v.variant} ({v.totalPurchasedBatches})
                  </button>
                ))}
              </div>

              {/* Purchase History Table (Desktop & Tablet) */}
              <div className="stock-history-table-container stock-desktop-history-table">
                <table className="stock-history-table">
                  <thead>
                    <tr>
                      <th className="stock-sortable-th" onClick={() => handleSortClick('date')} title="Click to sort by Date">
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span>Date</span>
                          {historySortField === 'date' && <span className="stock-sort-indicator">{historySortDir === 'asc' ? '↑' : '↓'}</span>}
                        </div>
                      </th>
                      <th className="stock-sortable-th" onClick={() => handleSortClick('brand')} title="Click to sort by Brand">
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span>Brand</span>
                          {historySortField === 'brand' && <span className="stock-sort-indicator">{historySortDir === 'asc' ? '↑' : '↓'}</span>}
                        </div>
                      </th>
                      <th className="stock-sortable-th" onClick={() => handleSortClick('variant')} title="Click to sort by Variant">
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span>Variant</span>
                          {historySortField === 'variant' && <span className="stock-sort-indicator">{historySortDir === 'asc' ? '↑' : '↓'}</span>}
                        </div>
                      </th>
                      <th className="stock-sortable-th" onClick={() => handleSortClick('source')} title="Click to sort by Source / Store">
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span>Source</span>
                          {historySortField === 'source' && <span className="stock-sort-indicator">{historySortDir === 'asc' ? '↑' : '↓'}</span>}
                        </div>
                      </th>
                      <th className="stock-sortable-th" onClick={() => handleSortClick('purchased')} title="Click to sort by Purchased Quantity">
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span>Purchased</span>
                          {historySortField === 'purchased' && <span className="stock-sort-indicator">{historySortDir === 'asc' ? '↑' : '↓'}</span>}
                        </div>
                      </th>
                      <th className="stock-sortable-th" onClick={() => handleSortClick('item_price')} title="Click to sort by Item Price">
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span>Item Price</span>
                          {historySortField === 'item_price' && <span className="stock-sort-indicator">{historySortDir === 'asc' ? '↑' : '↓'}</span>}
                        </div>
                      </th>
                      <th className="stock-sortable-th" onClick={() => handleSortClick('mrp')} title="Click to sort by MRP">
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span>MRP</span>
                          {historySortField === 'mrp' && <span className="stock-sort-indicator">{historySortDir === 'asc' ? '↑' : '↓'}</span>}
                        </div>
                      </th>
                      <th className="stock-sortable-th" onClick={() => handleSortClick('paid')} title="Click to sort by Paid Amount">
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span>Paid</span>
                          {historySortField === 'paid' && <span className="stock-sort-indicator">{historySortDir === 'asc' ? '↑' : '↓'}</span>}
                        </div>
                      </th>
                      <th className="stock-sortable-th" onClick={() => handleSortClick('saved')} title="Click to sort by Saved Amount">
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span>Saved</span>
                          {historySortField === 'saved' && <span className="stock-sort-indicator">{historySortDir === 'asc' ? '↑' : '↓'}</span>}
                        </div>
                      </th>
                      <th className="stock-sortable-th" onClick={() => handleSortClick('consumed')} title="Click to sort by Consumed Quantity">
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span>Consumed</span>
                          {historySortField === 'consumed' && <span className="stock-sort-indicator">{historySortDir === 'asc' ? '↑' : '↓'}</span>}
                        </div>
                      </th>
                      <th className="stock-sortable-th" onClick={() => handleSortClick('remaining')} title="Click to sort by Remaining Quantity">
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span>Rem. Qty</span>
                          {historySortField === 'remaining' && <span className="stock-sort-indicator">{historySortDir === 'asc' ? '↑' : '↓'}</span>}
                        </div>
                      </th>
                      <th className="stock-sortable-th" onClick={() => handleSortClick('remaining_val')} title="Click to sort by Remaining Value">
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span>Rem. Value</span>
                          {historySortField === 'remaining_val' && <span className="stock-sort-indicator">{historySortDir === 'asc' ? '↑' : '↓'}</span>}
                        </div>
                      </th>
                      <th className="stock-sortable-th" onClick={() => handleSortClick('status')} title="Click to sort by Status">
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span>Status</span>
                          {historySortField === 'status' && <span className="stock-sort-indicator">{historySortDir === 'asc' ? '↑' : '↓'}</span>}
                        </div>
                      </th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedProductBatches.map((batch, bIdx) => {
                      const isAvail = batch.remainingQty > 0;
                      const batchBrand = getBatchBrand(batch);
                      return (
                        <tr key={batch.id || `${batch.purchasedDate}_${bIdx}`}>
                          <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                            📅 {batch.purchasedDate || 'Unknown'}
                          </td>
                          <td>
                            {batchBrand ? <span className="stock-badge brand">{batchBrand}</span> : '—'}
                          </td>
                          <td>
                            <span className="stock-badge variant">{batch.variant}</span>
                          </td>
                          <td>
                            {getBatchSource(batch) ? <span className="stock-badge store">{getBatchSource(batch)}</span> : '-'}
                          </td>
                          <td style={{ fontWeight: 700 }}>
                            {formatFraction(batch.purchasedQty)}
                          </td>
                          <td style={{ fontWeight: 600 }}>₹{formatPriceVal(batch.unitPrice)}</td>
                          <td>₹{formatPriceVal(batch.mrp)}</td>
                          <td style={{ fontWeight: 700 }}>₹{formatPriceVal(batch.paid)}</td>
                          <td style={{ color: batch.savings < 0 ? 'var(--red, #ef4444)' : 'var(--green)' }}>
                            {batch.savings < 0 ? `-₹${formatPriceVal(Math.abs(batch.savings))}` : `₹${formatPriceVal(batch.savings)}`}
                          </td>
                          <td style={{ color: 'var(--text-muted)' }}>{formatFraction(batch.consumedQty)}</td>
                          <td style={{ fontWeight: 800, color: isAvail ? 'var(--green)' : 'var(--text-muted)' }}>
                            {formatFraction(batch.remainingQty)}
                          </td>
                          <td style={{ fontWeight: 700, color: isAvail ? 'var(--green)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                            {isAvail ? `₹${formatPriceVal((batch.remainingQty || 0) * (batch.unitPrice || 0))}` : '₹0'}
                          </td>
                          <td>
                            <span className={`stock-badge ${isAvail ? 'available' : 'unavailable'}`}>
                              {isAvail ? 'In Stock' : 'Out'}
                            </span>
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button
                                className="stock-btn-action history"
                                onClick={() => {
                                  setActiveActivityProduct(activeProductData.productName || selectedProduct);
                                  setActiveActivityBatchId(batch.batchId || batch.id);
                                }}
                                title="View transaction & stock movement history for this batch"
                              >
                                📜
                              </button>
                              {isAvail && (
                                <button
                                  className="stock-btn-action consume"
                                  onClick={() => handleOpenConsume(batch)}
                                  title="Consume / Use stock"
                                >
                                  🍽️ Use
                                </button>
                              )}
                              <button
                                className="stock-btn-action edit"
                                onClick={() => handleOpenEdit(batch)}
                                title="Edit batch"
                              >
                                ✏️
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Purchase History Cards (Mobile) */}
              <div className="stock-mobile-history-cards">
                {/* Mobile Sort Toolbar */}
                <div className="stock-mobile-sort-bar">
                  <span className="stock-mobile-sort-label">Sort:</span>
                  <select
                    className="stock-mobile-sort-select"
                    value={historySortField}
                    onChange={(e) => {
                      const newField = e.target.value;
                      if (newField === historySortField) {
                        setHistorySortDir(d => d === 'asc' ? 'desc' : 'asc');
                      } else {
                        setHistorySortField(newField);
                        setHistorySortDir(newField === 'date' ? 'desc' : 'asc');
                      }
                    }}
                  >
                    <option value="date">Date</option>
                    <option value="brand">Brand</option>
                    <option value="variant">Variant</option>
                    <option value="source">Source</option>
                    <option value="purchased">Purchased</option>
                    <option value="item_price">Item Price</option>
                    <option value="mrp">MRP</option>
                    <option value="paid">Paid</option>
                    <option value="saved">Saved</option>
                    <option value="consumed">Consumed</option>
                    <option value="remaining">Rem. Qty</option>
                    <option value="remaining_val">Rem. Value</option>
                    <option value="status">Status</option>
                  </select>
                  <button
                    type="button"
                    className="stock-mobile-sort-dir-btn"
                    onClick={() => setHistorySortDir(d => d === 'asc' ? 'desc' : 'asc')}
                    title={`Current: ${historySortDir === 'asc' ? 'Ascending' : 'Descending'}. Click to toggle.`}
                  >
                    {historySortDir === 'asc' ? '↑ Asc' : '↓ Desc'}
                  </button>
                </div>

                {sortedProductBatches.map((batch, bIdx) => {
                  const isAvail = batch.remainingQty > 0;
                  const batchBrand = getBatchBrand(batch);
                  return (
                    <div key={batch.id || `${batch.purchasedDate}_${bIdx}`} className="stock-batch-row">
                      <div className="stock-batch-meta">
                        <span style={{ fontWeight: 700 }}>
                          📅 {batch.purchasedDate || 'Unknown Date'}
                          {getBatchSource(batch) && ` @ ${getBatchSource(batch)}`}
                        </span>
                        <span className={`stock-badge ${isAvail ? 'available' : 'unavailable'}`}>
                          {isAvail ? `${formatFraction(batch.remainingQty)} avail` : 'Consumed'}
                        </span>
                      </div>
                      <div className="stock-batch-meta">
                        <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                          {batchBrand && <span className="stock-badge brand">{batchBrand}</span>}
                          <span className="stock-badge variant">{batch.variant}</span>
                        </div>
                        <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span>Item: <strong>₹{formatPriceVal(batch.unitPrice)}</strong></span>
                          <span>Paid: <strong>₹{formatPriceVal(batch.paid)}</strong> <span style={{ color: 'var(--text-muted)', fontSize: '0.62rem' }}>(MRP ₹{formatPriceVal(batch.mrp)})</span></span>
                          {isAvail && (
                            <span style={{ color: 'var(--green)', fontSize: '0.68rem', fontWeight: 700 }}>
                              (Rem: ₹{formatPriceVal((batch.remainingQty || 0) * (batch.unitPrice || 0))})
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                        <span style={{ fontSize: '0.65rem', color: batch.savings < 0 ? 'var(--red, #ef4444)' : 'var(--green)' }}>
                          {batch.savings < 0 ? `Variance -₹${formatPriceVal(Math.abs(batch.savings))}` : `Saved ₹${formatPriceVal(batch.savings)}`}
                        </span>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="stock-btn-action history"
                            onClick={() => {
                              setActiveActivityProduct(activeProductData.productName || selectedProduct);
                              setActiveActivityBatchId(batch.batchId || batch.id);
                            }}
                            title="View history for this batch"
                          >
                            📜
                          </button>
                          {isAvail && (
                            <button
                              className="stock-btn-action consume"
                              onClick={() => handleOpenConsume(batch)}
                            >
                              🍽️ Use
                            </button>
                          )}
                          <button
                            className="stock-btn-action edit"
                            onClick={() => handleOpenEdit(batch)}
                          >
                            ✏️
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            /* Main Product Catalog View */
            <>
              {/* Main Top Summary Card */}
              <div className="stock-summary-card">
                <div className="stock-summary-col">
                  <div className="stock-summary-label">Total Purchased</div>
                  <div className="stock-summary-val" style={{ color: 'var(--text-secondary)' }}>
                    {formatINR(stats.totalPurchased)}
                  </div>
                </div>
                <div className="stock-summary-divider" />
                <div className="stock-summary-col" title="Lifetime purchase savings from order discounts and promotional cashback.">
                  <div className="stock-summary-label">Saved</div>
                  <div className="stock-summary-val" style={{ color: 'var(--green)' }}>
                    {formatINR(stats.totalSaved)} <span style={{ fontSize: '0.68rem', fontWeight: 600 }}>({stats.savedPct}%)</span>
                  </div>
                </div>
                <div className="stock-summary-divider" />
                <div className="stock-summary-col">
                  <div className="stock-summary-label">Available Value</div>
                  <div className="stock-summary-val" style={{ color: 'var(--accent)' }}>
                    {formatINR(stats.availableValue)}
                  </div>
                </div>
              </div>

              {/* Filter Tabs */}
              <div className="stock-filters">
                <button
                  className={`stock-filter-btn ${filter === 'in_stock' ? 'active' : ''}`}
                  onClick={() => setFilter('in_stock')}
                >
                  In Stock ({canonicalProducts.filter(p => p.totalRemainingQty > 0).length})
                </button>
                <button
                  className={`stock-filter-btn ${filter === 'out_of_stock' ? 'active' : ''}`}
                  onClick={() => setFilter('out_of_stock')}
                >
                  Out of Stock ({canonicalProducts.filter(p => p.totalRemainingQty <= 0).length})
                </button>
                <button
                  className={`stock-filter-btn ${filter === 'all' ? 'active' : ''}`}
                  onClick={() => setFilter('all')}
                >
                  All Products ({canonicalProducts.length})
                </button>
              </div>

              {/* Search Bar */}
              <div className="stock-search-bar">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14" style={{ stroke: 'var(--text-muted)' }}>
                  <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  type="text"
                  className="stock-search-input"
                  placeholder="Search products, variants, or stores..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.9rem', cursor: 'pointer' }}
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Product Catalog Cards */}
              <div className="stock-item-list">
                {filteredProducts.map(prod => {
                  const isOut = prod.totalRemainingQty <= 0;
                  const avgUnitPrice = prod.totalPurchasedQty > 0 ? (prod.totalPaid / prod.totalPurchasedQty) : 0;
                  const prodPhysical = aggregateProductPhysicalQuantities(prod.batches || []);

                  return (
                    <div
                      key={prod.productName}
                      className="stock-item-card"
                      onClick={() => {
                        setSelectedProduct(prod.productName);
                        setSelectedVariant('all');
                      }}
                    >
                      <div className="stock-item-top">
                        <div className="stock-item-info">
                          <div className="stock-item-icon">{getEmoji(prod.productName)}</div>
                          <div className="stock-item-details" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                            <div className="stock-item-name" style={{ fontSize: '0.85rem', fontWeight: 800 }}>
                              {prod.productName}
                            </div>
                            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                              {prod.totalPurchasedBatches} historical {prod.totalPurchasedBatches === 1 ? 'batch' : 'batches'} • {prod.variantList.length} {prod.variantList.length === 1 ? 'variant' : 'variants'}
                            </div>
                          </div>
                        </div>
                        <div className="stock-item-qty-col" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div className={`stock-item-qty ${isOut ? 'out' : ''}`} style={{ fontSize: '0.82rem', fontWeight: 900 }}>
                              {isOut
                                ? 'Out of Stock'
                                : (prodPhysical?.hasPhysicalData && prodPhysical.remainingDisplay
                                    ? `${formatFraction(prod.totalRemainingQty)} packs (${prodPhysical.remainingDisplay})`
                                    : `${formatFraction(prod.totalRemainingQty)} in stock`)}
                            </div>
                            <button
                              type="button"
                              className="stock-btn-action history"
                              style={{ padding: '3px 6px', fontSize: '0.75rem', borderRadius: 6, lineHeight: 1 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveActivityProduct(prod.productName);
                                setActiveActivityBatchId(null);
                              }}
                              title="View Activity & Transaction History"
                            >
                              📜
                            </button>
                          </div>
                          <div className="stock-item-price" style={{ fontSize: '0.7rem', color: isOut ? 'var(--text-muted)' : 'var(--accent)', fontWeight: 700, marginTop: 1 }}>
                            {isOut ? `Avg: ₹${avgUnitPrice.toFixed(1)}` : `Value: ${formatINR(prod.availableValue)}`}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Edit Batch Modal */}
        {editingBatchId && (
          <div className="stock-purchase-modal" onClick={() => setEditingBatchId(null)}>
            <div className="stock-purchase-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '640px' }}>
              <div className="stock-modal-header">
                <div className="stock-modal-title">Edit Stock Item</div>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary stock-modal-close-btn"
                  onClick={() => setEditingBatchId(null)}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              <div className="stock-purchase-body">
                {/* Purchase Date & Store Name */}
                <div className="stock-row-grid-2">
                  <div className="mgr-edit-field">
                    <label className="stock-builder-lbl">Purchase Date</label>
                    <input
                      type="date"
                      className="form-input"
                      value={editFormData.purchased_date || ''}
                      onChange={e => setEditFormData(prev => ({ ...prev, purchased_date: e.target.value }))}
                    />
                  </div>
                  <div className="mgr-edit-field" style={{ position: 'relative' }}>
                    <label className="stock-builder-lbl">Store Name</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="e.g. DMart, Amazon"
                      value={editFormData.notes || ''}
                      onFocus={() => setActiveStoreEditSug(true)}
                      onBlur={() => setTimeout(() => setActiveStoreEditSug(false), 200)}
                      onChange={e => {
                        setEditFormData(prev => ({ ...prev, notes: e.target.value }));
                        setActiveStoreEditSug(true);
                      }}
                    />
                    {activeStoreEditSug && storeSuggestions.filter(s => s.toLowerCase().includes((editFormData.notes || '').toLowerCase())).length > 0 && (
                      <div className="note-sug-list" style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 1000, maxHeight: 160, overflowY: 'auto' }}>
                        {storeSuggestions.filter(s => s.toLowerCase().includes((editFormData.notes || '').toLowerCase())).slice(0, 8).map(sug => (
                          <div
                            key={sug}
                            className="note-sug-item"
                            onMouseDown={() => {
                              setEditFormData(prev => ({ ...prev, notes: sug }));
                              setActiveStoreEditSug(false);
                            }}
                            style={{ fontSize: '0.75rem', padding: '6px 10px', cursor: 'pointer' }}
                          >
                            {sug}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="stock-item-row-builder" style={{ marginTop: 10 }}>
                  {/* Identity: Item Name */}
                  <div className="mgr-edit-field" style={{ position: 'relative' }}>
                    <label className="stock-builder-lbl">Item Name</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="e.g. Cooking Oil, Gemini Tea"
                      value={editFormData.name || ''}
                      onFocus={() => setActiveEditItemSug(true)}
                      onBlur={() => setTimeout(() => setActiveEditItemSug(false), 200)}
                      onChange={e => {
                        const val = e.target.value;
                        setEditFormData(prev => ({ ...prev, name: val }));
                        setActiveEditItemSug(true);
                      }}
                    />
                    {activeEditItemSug && itemSuggestions.filter(s => s.toLowerCase().includes((editFormData.name || '').toLowerCase())).length > 0 && (
                      <div className="note-sug-list" style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 1000, maxHeight: 150, overflowY: 'auto' }}>
                        {itemSuggestions.filter(s => s.toLowerCase().includes((editFormData.name || '').toLowerCase())).slice(0, 8).map(sug => (
                          <div
                            key={sug}
                            className="note-sug-item"
                            onMouseDown={() => {
                              setEditFormData(prev => ({ ...prev, name: sug }));
                              setActiveEditItemSug(false);
                            }}
                            style={{ fontSize: '0.75rem', padding: '6px 10px', cursor: 'pointer' }}
                          >
                            {sug}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Identity: Category & Brand */}
                  <div className="stock-row-grid-2">
                    <div className="mgr-edit-field">
                      <label className="stock-builder-lbl">Category</label>
                      <select
                        className="form-input"
                        value={editFormData.category || 'Groceries'}
                        onChange={e => setEditFormData(prev => ({ ...prev, category: e.target.value }))}
                      >
                        {availableStockCategories.map(cat => (
                          <option key={cat} value={cat}>{cat}</option>
                        ))}
                      </select>
                      {editFormData.category === 'Other' && (
                        <input
                          type="text"
                          className="form-input"
                          placeholder="Custom Category Name"
                          style={{ marginTop: 6 }}
                          value={editFormData.customCategory || ''}
                          onChange={e => setEditFormData(prev => ({ ...prev, customCategory: e.target.value }))}
                        />
                      )}
                    </div>
                    <div className="mgr-edit-field">
                      <label className="stock-builder-lbl">Brand (Optional)</label>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="e.g. Gemini, Fortune"
                        value={editFormData.brand || ''}
                        onChange={e => setEditFormData(prev => ({ ...prev, brand: e.target.value }))}
                      />
                    </div>
                  </div>

                  {/* Pack: Pack Size & Pack Unit */}
                  <div className="stock-row-grid-2">
                    <div className="mgr-edit-field">
                      <label className="stock-builder-lbl">Pack Size</label>
                      <input
                        type="number"
                        step="any"
                        className="form-input"
                        placeholder="e.g. 5, 200, 1"
                        value={editFormData.sub_qty || ''}
                        onChange={e => setEditFormData(prev => ({ ...prev, sub_qty: e.target.value }))}
                      />
                    </div>
                    <div className="mgr-edit-field">
                      <label className="stock-builder-lbl">Pack Unit</label>
                      <select
                        className="form-input"
                        value={normalizeUnit(editFormData.sub_unit)}
                        onChange={e => setEditFormData(prev => ({ ...prev, sub_unit: e.target.value }))}
                      >
                        <option value="g">g</option>
                        <option value="kg">kg</option>
                        <option value="ml">ml</option>
                        <option value="litre">litre</option>
                        <option value="pcs">pcs</option>
                        <option value="box">box</option>
                        <option value="packet">packet</option>
                      </select>
                    </div>
                  </div>

                  {/* Pack: Qty/Packs, Parts, Available Parts */}
                  <div className="stock-row-grid-3">
                    <div className="mgr-edit-field">
                      <label className="stock-builder-lbl">Qty / Packs</label>
                      <input
                        type="number"
                        step="any"
                        className="form-input"
                        placeholder="1"
                        value={editFormData.pack_qty || ''}
                        onChange={e => setEditFormData(prev => ({ ...prev, pack_qty: e.target.value }))}
                      />
                    </div>
                    <div className="mgr-edit-field">
                      <label className="stock-builder-lbl">Parts (N)</label>
                      <input
                        type="number"
                        step="any"
                        className="form-input"
                        placeholder="1"
                        value={editFormData.original_qty || ''}
                        onChange={e => setEditFormData(prev => ({ ...prev, original_qty: e.target.value }))}
                      />
                    </div>
                    <div className="mgr-edit-field">
                      <label className="stock-builder-lbl">Available Parts (N)</label>
                      <input
                        type="number"
                        step="any"
                        className="form-input"
                        placeholder="1"
                        value={editFormData.qty || ''}
                        onChange={e => setEditFormData(prev => ({ ...prev, qty: e.target.value }))}
                      />
                    </div>
                  </div>

                  {/* Pricing: Original Price / MRP, Discount Type, Discount / Final Value */}
                  <div className="stock-pricing-grid">
                    <div className="mgr-edit-field">
                      <label className="stock-builder-lbl">Original Price / MRP</label>
                      <input
                        type="number"
                        step="any"
                        className="form-input"
                        value={editFormData.price || ''}
                        onChange={e => setEditFormData(prev => ({ ...prev, price: e.target.value }))}
                      />
                    </div>
                    <div className="mgr-edit-field">
                      <label className="stock-builder-lbl">Discount Type</label>
                      <select
                        className="form-input"
                        value={editFormData.discountType || 'final_price'}
                        onChange={e => setEditFormData(prev => ({ ...prev, discountType: e.target.value }))}
                      >
                        <option value="final_price">Final Price</option>
                        <option value="percentage">%</option>
                        <option value="fixed">₹ Discount</option>
                      </select>
                    </div>
                    <div className="mgr-edit-field">
                      <label className="stock-builder-lbl">
                        {editFormData.discountType === 'percentage'
                          ? 'Discount (%)'
                          : editFormData.discountType === 'fixed'
                            ? 'Discount (₹)'
                            : 'Final Price (₹)'}
                      </label>
                      <input
                        type="number"
                        step="any"
                        className="form-input"
                        value={editFormData.discountValue || ''}
                        onChange={e => setEditFormData(prev => ({ ...prev, discountValue: e.target.value }))}
                      />
                    </div>
                  </div>

                  {/* Calculated Metrics Live Preview */}
                  {(() => {
                    const editCalcs = getItemCalculations(editFormData);
                    return (
                      <div className="stock-item-calc-preview">
                        <div className="stock-calc-col">
                          <span className="stock-calc-lbl">Paid Price</span>
                          <span className="stock-calc-val paid">{formatINR(editCalcs.paidPrice, editCalcs.paidPrice % 1 !== 0 ? 2 : 0)}</span>
                        </div>
                        <div className="stock-calc-col">
                          <span className="stock-calc-lbl">Price / Unit</span>
                          <span className="stock-calc-val">{formatINR(editCalcs.pricePerUnit, editCalcs.pricePerUnit % 1 !== 0 ? 2 : 0)}</span>
                        </div>
                        <div className="stock-calc-col">
                          <span className="stock-calc-lbl">Remaining Value</span>
                          <span className="stock-calc-val avail">{formatINR(editCalcs.remainingValue, editCalcs.remainingValue % 1 !== 0 ? 2 : 0)}</span>
                        </div>
                        {editCalcs.saved > 0 && (
                          <div className="stock-calc-col">
                            <span className="stock-calc-lbl">Saved</span>
                            <span className="stock-calc-val" style={{ color: 'var(--green)' }}>{formatINR(editCalcs.saved, editCalcs.saved % 1 !== 0 ? 2 : 0)}</span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ flex: 1, padding: '10px' }}
                    disabled={isSavingEdit}
                    onClick={() => handleSaveEditBatch(editingBatchId)}
                  >
                    {isSavingEdit ? '⏳ Saving…' : 'Save Changes'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ padding: '10px 18px' }}
                    disabled={isSavingEdit}
                    onClick={() => setEditingBatchId(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Consume / Use Modal */}
        {consumingItemId && (
          <div
            className="stock-batch-row animate-pop"
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '90%',
              maxWidth: '440px',
              minHeight: '440px',
              gap: 10,
              padding: 16,
              zIndex: 1000,
              background: 'var(--bg-card)',
              borderRadius: '14px',
              border: '1.5px solid var(--accent)',
              boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.5)',
              maxHeight: '90vh',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <div className="stock-use-header">
              <div>
                <div className="stock-builder-lbl" style={{ color: 'var(--accent)', fontWeight: 800, fontSize: '0.88rem' }}>
                  Use Item: {consumingItemName} ({consumingItemBatchDate || 'Batch'})
                </div>
                <div className="stock-avail-pill">
                  <span>📦 Total Available:</span>
                  <strong>{formatFraction(consumingBatch?.remainingQty || 0)} {consumingBatch?.unit || 'pcs'}</strong>
                  {consumingBatch?.sub_qty > 1 && (
                    <span style={{ opacity: 0.85, fontSize: '0.68rem' }}>
                      ({formatFraction((consumingBatch.remainingQty || 0) * consumingBatch.sub_qty)} {consumingBatch.sub_unit})
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="stock-use-close-btn"
                disabled={isSavingConsume}
                onClick={() => {
                  if (!isSavingConsume) {
                    setConsumingItemId(null);
                    setConsumeError('');
                  }
                }}
                title="Close"
              >
                ✕
              </button>
            </div>

            {isSavingConsume && (
              <div className="stock-saving-banner">
                <span>⏳</span>
                <span>Saving stock usage… Please wait.</span>
              </div>
            )}

            {/* Row 1: Date & Time */}
            <div className="stock-row-grid-2">
              <div className="mgr-edit-field">
                <label className="stock-builder-lbl">Date</label>
                <input
                  type="date"
                  className="form-input"
                  disabled={isSavingConsume}
                  value={consumeDate}
                  onChange={e => setConsumeDate(e.target.value)}
                />
              </div>
              <div className="mgr-edit-field">
                <label className="stock-builder-lbl">Time</label>
                <input
                  type="time"
                  className="form-input"
                  disabled={isSavingConsume}
                  value={consumeTime}
                  onChange={e => setConsumeTime(e.target.value)}
                />
              </div>
            </div>

            {/* Row 2: Action tabs: Consume, Lend, Instalment */}
            <div className="stock-usage-tabs">
              <button
                type="button"
                className={`stock-usage-tab-btn ${usageType === 'consume' ? 'active consume' : ''}`}
                disabled={isSavingConsume}
                onClick={() => setUsageType('consume')}
              >
                🍽️ Consume
              </button>
              <button
                type="button"
                className={`stock-usage-tab-btn ${usageType === 'lend' ? 'active lend' : ''}`}
                disabled={isSavingConsume}
                onClick={() => setUsageType('lend')}
              >
                🤝 Lend
              </button>
              <button
                type="button"
                className={`stock-usage-tab-btn ${usageType === 'instalment' ? 'active instalment' : ''}`}
                disabled={isSavingConsume}
                onClick={() => setUsageType('instalment')}
              >
                📋 Instalment
              </button>
            </div>

            {/* Row 4: Quantity to Use */}
            <div className="mgr-edit-field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                <label className="stock-builder-lbl" style={{ margin: 0 }}>Quantity to Use</label>
                {consumingBatch?.sub_qty > 1 && (
                  <div className="stock-mode-toggle-group">
                    <button
                      type="button"
                      className={`stock-mode-toggle-btn ${consumeUnitMode === 'pack' ? 'active' : ''}`}
                      onClick={() => setConsumeUnitMode('pack')}
                    >
                      {consumingBatch?.unit || 'Packs'}
                    </button>
                    <button
                      type="button"
                      className={`stock-mode-toggle-btn ${consumeUnitMode === 'sub' ? 'active' : ''}`}
                      onClick={() => setConsumeUnitMode('sub')}
                    >
                      {consumingBatch?.sub_unit || 'Units'}
                    </button>
                  </div>
                )}
              </div>
              <input
                type="number"
                step="any"
                disabled={isSavingConsume}
                className={`form-input ${consumeError ? 'err' : ''}`}
                placeholder={`Max ${formatFraction(consumingBatch?.remainingQty || 0)}`}
                value={consumeQty}
                onChange={e => {
                  setConsumeQty(e.target.value);
                  setConsumeError('');
                }}
              />
            </div>

            {/* Row 5: Type-specific options */}
            {usageType === 'lend' ? (
              <div className="mgr-edit-field" style={{ position: 'relative' }}>
                <label className="stock-builder-lbl">Lend to (Person)</label>
                <input
                  type="text"
                  className="form-input"
                  disabled={isSavingConsume}
                  placeholder="Person name..."
                  value={personName}
                  onClick={e => { if (!isSavingConsume) { e.stopPropagation(); setActiveLendSug(true); } }}
                  onFocus={() => { if (!isSavingConsume) setActiveLendSug(true); }}
                  onBlur={() => setTimeout(() => setActiveLendSug(false), 200)}
                  onChange={e => {
                    setPersonName(e.target.value);
                    setActiveLendSug(true);
                  }}
                />
                {!isSavingConsume && activeLendSug && debtPeople.filter(p => p.toLowerCase().includes(personName.toLowerCase())).length > 0 && (
                  <div className="note-sug-list" style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 1000, maxHeight: 180, overflowY: 'auto' }}>
                    {debtPeople.filter(p => p.toLowerCase().includes(personName.toLowerCase())).map(item => (
                      <div
                        key={item}
                        className="note-sug-item"
                        onMouseDown={() => {
                          setPersonName(item);
                          setActiveLendSug(false);
                        }}
                        style={{ fontSize: '0.75rem', padding: '8px 12px', cursor: 'pointer' }}
                      >
                        {item}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : usageType === 'instalment' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="stock-row-grid-2">
                  <div className="mgr-edit-field">
                    <label className="stock-builder-lbl">Category</label>
                    <select
                      className="form-input"
                      disabled={isSavingConsume}
                      value={consumeCategory}
                      onChange={e => {
                        setConsumeCategory(e.target.value);
                        const firstSub = categories?.[e.target.value]?.subcategories?.[0] || '';
                        setConsumeSubcategory(firstSub);
                      }}
                    >
                      {categoriesList.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="mgr-edit-field">
                    <label className="stock-builder-lbl">Subcategory</label>
                    <select
                      className="form-input"
                      disabled={isSavingConsume}
                      value={consumeSubcategory}
                      onChange={e => setConsumeSubcategory(e.target.value)}
                    >
                      {subcategoriesList.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>

                <div className="stock-row-grid-2">
                  <div className="mgr-edit-field">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 22, marginBottom: 4 }}>
                      <label className="stock-builder-lbl" style={{ margin: 0 }}>Duration</label>
                      <div className="stock-mode-toggle-group">
                        <button
                          type="button"
                          className={`stock-mode-toggle-btn ${instalmentInputMode === 'months' ? 'active' : ''}`}
                          onClick={() => setInstalmentInputMode('months')}
                        >
                          Months
                        </button>
                        <button
                          type="button"
                          className={`stock-mode-toggle-btn ${instalmentInputMode === 'days' ? 'active' : ''}`}
                          onClick={() => setInstalmentInputMode('days')}
                        >
                          Days
                        </button>
                      </div>
                    </div>
                    {instalmentInputMode === 'months' ? (
                      <input
                        type="number"
                        min="2"
                        className="form-input"
                        placeholder="e.g. 3"
                        value={instalmentMonths}
                        onChange={e => setInstalmentMonths(e.target.value)}
                      />
                    ) : (
                      <input
                        type="number"
                        min="31"
                        className="form-input"
                        placeholder="e.g. 90"
                        value={instalmentDays}
                        onChange={e => setInstalmentDays(e.target.value)}
                      />
                    )}
                  </div>
                  <div className="mgr-edit-field">
                    <div style={{ display: 'flex', alignItems: 'center', minHeight: 22, marginBottom: 4 }}>
                      <label className="stock-builder-lbl" style={{ margin: 0 }}>Schedule Mode</label>
                    </div>
                    <select
                      className="form-input"
                      value={instalmentScheduleMode}
                      onChange={e => setInstalmentScheduleMode(e.target.value)}
                    >
                      <option value="on_date">On the Date</option>
                      <option value="start_of_month">1st of Each Month</option>
                    </select>
                  </div>
                </div>
              </div>
            ) : (
              <div className="stock-row-grid-2">
                <div className="mgr-edit-field">
                  <label className="stock-builder-lbl">Category</label>
                  <select
                    className="form-input"
                    disabled={isSavingConsume}
                    value={consumeCategory}
                    onChange={e => {
                      setConsumeCategory(e.target.value);
                      const firstSub = categories?.[e.target.value]?.subcategories?.[0] || '';
                      setConsumeSubcategory(firstSub);
                    }}
                  >
                    {categoriesList.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="mgr-edit-field">
                  <label className="stock-builder-lbl">Subcategory</label>
                  <select
                    className="form-input"
                    disabled={isSavingConsume}
                    value={consumeSubcategory}
                    onChange={e => setConsumeSubcategory(e.target.value)}
                  >
                    {subcategoriesList.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
            )}

            {/* Row 3: Note field (3rd row for Consume, Lend, and Installment) */}
            <div className="mgr-edit-field" style={{ position: 'relative' }}>
              <label className="stock-builder-lbl">Note (Optional)</label>
              <NoteAutocompleteInput
                value={consumeUserNote}
                disabled={isSavingConsume}
                onChange={setConsumeUserNote}
                transactions={transactions}
                placeholder="Note / store / purpose..."
              />
            </div>

            {/* Row 6: Description field (for Consume, Lend, and Installment) */}
            <div className="mgr-edit-field">
              <label className="stock-builder-lbl">Description (Optional)</label>
              <input
                type="text"
                className="form-input"
                disabled={isSavingConsume}
                placeholder="Additional description..."
                value={consumeDescription}
                onChange={e => setConsumeDescription(e.target.value)}
              />
            </div>

            {consumeError && <div className="field-error">{consumeError}</div>}

            <div className="stock-modal-actions">
              <button
                type="button"
                className="stock-confirm-btn"
                disabled={isSavingConsume}
                style={{ opacity: isSavingConsume ? 0.7 : 1, cursor: isSavingConsume ? 'not-allowed' : 'pointer' }}
                onClick={handleConsume}
              >
                {isSavingConsume ? '⏳ Saving Stock Usage…' : 'Confirm'}
              </button>
              <button
                type="button"
                className="stock-cancel-btn"
                disabled={isSavingConsume}
                style={{ opacity: isSavingConsume ? 0.5 : 1, cursor: isSavingConsume ? 'not-allowed' : 'pointer' }}
                onClick={() => {
                  if (!isSavingConsume) {
                    setConsumingItemId(null);
                    setConsumeError('');
                  }
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Purchase Modal */}
        {showPurchaseModal && (
          <div className="stock-purchase-modal" onClick={() => setShowPurchaseModal(false)}>
            <div
              className="stock-purchase-content"
              onClick={e => e.stopPropagation()}
              onMouseDown={(e) => {
                if (!['input', 'textarea', 'button', 'select'].includes((e.target.tagName || '').toLowerCase())) {
                  if (document.activeElement && typeof document.activeElement.blur === 'function') {
                    document.activeElement.blur();
                  }
                }
              }}
            >
              <div className="stock-modal-header">
                <div className="stock-modal-title">New Stock Purchase</div>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary stock-modal-close-btn"
                  onClick={() => setShowPurchaseModal(false)}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
              <div className="stock-purchase-body">
                <div className="stock-row-grid-3">
                  <div className="mgr-edit-field">
                    <label className="stock-builder-lbl">Date</label>
                    <input
                      type="date"
                      className="form-input"
                      value={purchaseDate}
                      onChange={e => setPurchaseDate(e.target.value)}
                    />
                  </div>
                  <div className="mgr-edit-field">
                    <label className="stock-builder-lbl">Time</label>
                    <input
                      type="time"
                      className="form-input"
                      value={purchaseTime}
                      onChange={e => setPurchaseTime(e.target.value)}
                    />
                  </div>
                  <div className="mgr-edit-field">
                    <label className="stock-builder-lbl">Note</label>
                    <NoteAutocompleteInput
                      value={purchaseNote}
                      onChange={setPurchaseNote}
                      transactions={transactions}
                      placeholder="e.g. in stock, Amazon Fresh..."
                    />
                  </div>
                </div>

                <div className="stock-account-picker-row" style={{ width: '100%', position: 'relative', marginBottom: 12 }}>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: availablePurchaseSubAccounts.length > 0 ? '1fr 1fr' : '1fr',
                    gap: 10,
                    width: '100%'
                  }}>
                    <div ref={accountPickerRef} style={{ width: '100%', position: 'relative' }}>
                      <label className="stock-builder-lbl">Paid From</label>
                      <button
                        type="button"
                        className="picker-trigger"
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          boxSizing: 'border-box'
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowAccountPicker(prev => !prev);
                          setShowSubAccountPicker(false);
                        }}
                      >
                        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {purchaseFrom || 'Select Account...'}
                        </span>
                        <span style={{ fontSize: '0.7rem', opacity: 0.7, marginLeft: 6 }}>▼</span>
                      </button>
                      {showAccountPicker && (
                        <div
                          className="picker-sheet-dropdown"
                          style={{
                            position: 'absolute',
                            left: 0,
                            top: 'calc(100% + 4px)',
                            width: availablePurchaseSubAccounts.length > 0 ? 'min(360px, 90vw)' : '100%',
                            minWidth: '280px',
                            maxWidth: '420px',
                            zIndex: 1200,
                            maxHeight: 280,
                            overflowY: 'auto'
                          }}
                          onClick={e => e.stopPropagation()}
                        >
                          <div className="picker-search-wrap">
                            <span className="picker-search-icon">🔍</span>
                            <input
                              type="text"
                              className="picker-search-input"
                              placeholder="Search account…"
                              value={accountSearchQuery}
                              onChange={e => setAccountSearchQuery(e.target.value)}
                              autoFocus
                            />
                            {accountSearchQuery && (
                              <button type="button" className="picker-search-clear" onClick={() => setAccountSearchQuery('')}>✕</button>
                            )}
                          </div>
                          {recentAccountsList.length > 0 && !accountSearchQuery && (
                            <>
                              <div className="picker-section-label">Recent</div>
                              <div className="picker-recent-row">
                                {recentAccountsList.map(accName => (
                                  <button
                                    key={accName}
                                    type="button"
                                    className={`picker-chip ${purchaseFrom === accName ? 'picker-chip-active' : ''}`}
                                    onClick={() => handleSelectPurchaseAccount(accName)}
                                  >
                                    {accName}{purchaseFrom === accName && <span className="picker-chip-check"> ✓</span>}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}
                          <div className="picker-section-label">
                            {accountSearchQuery ? 'Matching Accounts' : 'All Accounts'}
                          </div>
                          <div className="picker-chip-grid">
                            {filteredAccountList.map(accName => (
                              <button
                                key={accName}
                                type="button"
                                className={`picker-chip ${purchaseFrom === accName ? 'picker-chip-active' : ''}`}
                                onClick={() => handleSelectPurchaseAccount(accName)}
                              >
                                {accName}{purchaseFrom === accName && <span className="picker-chip-check"> ✓</span>}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Sub Account Field */}
                    {availablePurchaseSubAccounts.length > 0 && (
                      <div ref={subAccountPickerRef} style={{ width: '100%', position: 'relative' }}>
                        <label className="stock-builder-lbl">Sub Account</label>
                        <button
                          type="button"
                          className="picker-trigger"
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            boxSizing: 'border-box'
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowSubAccountPicker(prev => !prev);
                            setShowAccountPicker(false);
                          }}
                        >
                          <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {purchaseSubAccount || 'Select Sub Account'}
                          </span>
                          <span style={{ fontSize: '0.7rem', opacity: 0.7, marginLeft: 6 }}>▼</span>
                        </button>
                        {showSubAccountPicker && (
                          <div
                            className="picker-sheet-dropdown"
                            style={{
                              position: 'absolute',
                              right: 0,
                              top: 'calc(100% + 4px)',
                              width: 'min(360px, 90vw)',
                              minWidth: '260px',
                              maxWidth: '380px',
                              zIndex: 1200,
                              maxHeight: 240,
                              overflowY: 'auto'
                            }}
                            onClick={e => e.stopPropagation()}
                          >
                            <div className="picker-section-label">Sub Accounts</div>
                            <div className="picker-chip-grid">
                              {availablePurchaseSubAccounts.map(sub => (
                                <button
                                  key={sub}
                                  type="button"
                                  className={`picker-chip ${purchaseSubAccount === sub ? 'picker-chip-active' : ''}`}
                                  onClick={() => {
                                    setPurchaseSubAccount(sub);
                                    setShowSubAccountPicker(false);
                                  }}
                                >
                                  {sub}{purchaseSubAccount === sub && <span className="picker-chip-check"> ✓</span>}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {errors.fromAccount && <div className="field-error">{errors.fromAccount}</div>}
                </div>

                {purchaseItems.map((item, idx) => {
                  const calcs = getItemCalculations(item);
                  return (
                    <div key={item._id} className="stock-item-row-builder">
                      {purchaseItems.length > 1 && (
                        <button
                          type="button"
                          className="stock-row-delete-btn"
                          title="Remove item"
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setPurchaseItems(prev => prev.filter(it => it._id !== item._id));
                          }}
                        >
                          ✕
                        </button>
                      )}

                      {/* Identity: Item Name */}
                      <div className="mgr-edit-field" style={{ position: 'relative' }}>
                        <label className="stock-builder-lbl">Item Name</label>
                        <input
                          type="text"
                          className="form-input"
                          placeholder="e.g. Cooking Oil, Gemini Tea"
                          value={item.name}
                          onClick={e => { e.stopPropagation(); setActiveItemSugIdx(idx); }}
                          onFocus={() => setActiveItemSugIdx(idx)}
                          onBlur={() => setTimeout(() => setActiveItemSugIdx(null), 200)}
                          onChange={e => {
                            const val = e.target.value;
                            updatePurchaseItem(item._id, 'name', val);
                            const match = existingProductLookup.get(val.toLowerCase().trim());
                            if (match) {
                              if (match.category) {
                                if (DEFAULT_STOCK_CATEGORIES.includes(match.category)) {
                                  updatePurchaseItem(item._id, 'category', match.category);
                                } else {
                                  updatePurchaseItem(item._id, 'category', 'Other');
                                  updatePurchaseItem(item._id, 'customCategory', match.category);
                                }
                              }
                              if (match.brand) updatePurchaseItem(item._id, 'brand', match.brand);
                              if (match.sub_qty) updatePurchaseItem(item._id, 'sub_qty', match.sub_qty);
                              if (match.sub_unit) updatePurchaseItem(item._id, 'sub_unit', match.sub_unit);
                            }
                            setActiveItemSugIdx(idx);
                          }}
                        />
                        {activeItemSugIdx === idx && itemSuggestions.filter(s => s.toLowerCase().includes((item.name || '').toLowerCase())).length > 0 && (
                          <div className="note-sug-list" style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 1000, maxHeight: 140, overflowY: 'auto' }}>
                            {itemSuggestions.filter(s => s.toLowerCase().includes((item.name || '').toLowerCase())).slice(0, 8).map(sug => (
                              <div
                                key={sug}
                                className="note-sug-item"
                                onMouseDown={() => handleSelectProductSuggestion(item._id, sug)}
                                style={{ fontSize: '0.75rem', padding: '6px 10px', cursor: 'pointer' }}
                              >
                                {sug}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Identity: Category & Brand */}
                      <div className="stock-row-grid-2">
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Category</label>
                          <select
                            className="form-input"
                            value={item.category || 'Groceries'}
                            onChange={e => updatePurchaseItem(item._id, 'category', e.target.value)}
                          >
                            {availableStockCategories.map(cat => (
                              <option key={cat} value={cat}>{cat}</option>
                            ))}
                          </select>
                          {item.category === 'Other' && (
                            <input
                              type="text"
                              className="form-input"
                              placeholder="Custom Category Name"
                              style={{ marginTop: 6 }}
                              value={item.customCategory || ''}
                              onChange={e => updatePurchaseItem(item._id, 'customCategory', e.target.value)}
                            />
                          )}
                        </div>
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Brand (Optional)</label>
                          <input
                            type="text"
                            className="form-input"
                            placeholder="e.g. Gemini, Fortune"
                            value={item.brand || ''}
                            onChange={e => updatePurchaseItem(item._id, 'brand', e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Pack: Pack Size & Pack Unit */}
                      <div className="stock-row-grid-2">
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Pack Size</label>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            placeholder="e.g. 5, 200, 1"
                            value={item.sub_qty}
                            onChange={e => updatePurchaseItem(item._id, 'sub_qty', e.target.value)}
                          />
                        </div>
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Pack Unit</label>
                          <select
                            className="form-input"
                            value={normalizeUnit(item.sub_unit)}
                            onChange={e => updatePurchaseItem(item._id, 'sub_unit', e.target.value)}
                          >
                            <option value="g">g</option>
                            <option value="kg">kg</option>
                            <option value="ml">ml</option>
                            <option value="litre">litre</option>
                            <option value="pcs">pcs</option>
                            <option value="box">box</option>
                            <option value="packet">packet</option>
                          </select>
                        </div>
                      </div>

                      {/* Pack: Qty/Packs, Parts, Available Parts */}
                      <div className="stock-row-grid-3">
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Qty / Packs</label>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            placeholder="1"
                            value={item.pack_qty}
                            onChange={e => updatePurchaseItem(item._id, 'pack_qty', e.target.value)}
                          />
                        </div>
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Parts (N)</label>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            placeholder="1"
                            value={item.original_qty}
                            onChange={e => updatePurchaseItem(item._id, 'original_qty', e.target.value)}
                          />
                        </div>
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Available Parts (N)</label>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            placeholder="1"
                            value={item.qty}
                            onChange={e => updatePurchaseItem(item._id, 'qty', e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Pricing: Original Price / MRP, Discount Type, Discount / Final Value */}
                      <div className="stock-pricing-grid">
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Original Price / MRP</label>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            value={item.price}
                            onChange={e => updatePurchaseItem(item._id, 'price', e.target.value)}
                          />
                        </div>
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Discount Type</label>
                          <select
                            className="form-input"
                            value={item.discountType || 'final_price'}
                            onChange={e => updatePurchaseItem(item._id, 'discountType', e.target.value)}
                          >
                            <option value="final_price">Final Price</option>
                            <option value="percentage">%</option>
                            <option value="fixed">₹ Discount</option>
                          </select>
                        </div>
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">
                            {item.discountType === 'percentage'
                              ? 'Discount (%)'
                              : item.discountType === 'fixed'
                                ? 'Discount (₹)'
                                : 'Final Price (₹)'}
                          </label>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            value={item.discountValue}
                            onChange={e => updatePurchaseItem(item._id, 'discountValue', e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Source: Store Name */}
                      <div className="mgr-edit-field" style={{ position: 'relative' }}>
                        <label className="stock-builder-lbl">Store Name</label>
                        <input
                          type="text"
                          className="form-input"
                          placeholder="e.g. DMart, Amazon"
                          value={item.notes}
                          onFocus={() => setActiveStoreSugIdx(idx)}
                          onBlur={() => setTimeout(() => setActiveStoreSugIdx(null), 200)}
                          onChange={e => {
                            updatePurchaseItem(item._id, 'notes', e.target.value);
                            setActiveStoreSugIdx(idx);
                          }}
                        />
                        {activeStoreSugIdx === idx && storeSuggestions.filter(s => s.toLowerCase().includes((item.notes || '').toLowerCase())).length > 0 && (
                          <div className="note-sug-list" style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 1000, maxHeight: 140, overflowY: 'auto' }}>
                            {storeSuggestions.filter(s => s.toLowerCase().includes((item.notes || '').toLowerCase())).slice(0, 8).map(sug => (
                              <div
                                key={sug}
                                className="note-sug-item"
                                onMouseDown={() => {
                                  updatePurchaseItem(item._id, 'notes', sug);
                                  setActiveStoreSugIdx(null);
                                }}
                                style={{ fontSize: '0.75rem', padding: '6px 10px', cursor: 'pointer' }}
                              >
                                {sug}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Calculated Metrics Live Preview */}
                      <div className="stock-item-calc-preview">
                        <div className="stock-calc-col">
                          <span className="stock-calc-lbl">Paid Price</span>
                          <span className="stock-calc-val paid">{formatINR(calcs.paidPrice, calcs.paidPrice % 1 !== 0 ? 2 : 0)}</span>
                        </div>
                        <div className="stock-calc-col">
                          <span className="stock-calc-lbl">Price / Unit</span>
                          <span className="stock-calc-val">{formatINR(calcs.pricePerUnit, calcs.pricePerUnit % 1 !== 0 ? 2 : 0)}</span>
                        </div>
                        <div className="stock-calc-col">
                          <span className="stock-calc-lbl">Remaining Value</span>
                          <span className="stock-calc-val avail">{formatINR(calcs.remainingValue, calcs.remainingValue % 1 !== 0 ? 2 : 0)}</span>
                        </div>
                        {calcs.saved > 0 && (
                          <div className="stock-calc-col">
                            <span className="stock-calc-lbl">Saved</span>
                            <span className="stock-calc-val" style={{ color: 'var(--green)' }}>{formatINR(calcs.saved, calcs.saved % 1 !== 0 ? 2 : 0)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ width: '100%', padding: '8px' }}
                  onClick={() => {
                    const firstItem = purchaseItems[0];
                    const newItem = createEmptyPurchaseItem();
                    if (firstItem) {
                      if (firstItem.discountType) newItem.discountType = firstItem.discountType;
                      if (firstItem.discountValue !== undefined && firstItem.discountValue !== '') {
                        newItem.discountValue = firstItem.discountValue;
                      }
                    }
                    setPurchaseItems(prev => [...prev, newItem]);
                  }}
                >
                  ➕ Add Another Item
                </button>

                <div className="grand-total-section">
                  <span>Grand Total:</span>
                  <span style={{ fontWeight: 800, color: 'var(--green)', fontSize: '1rem' }}>
                    {formatINR(totalPurchaseSum, totalPurchaseSum % 1 !== 0 ? 2 : 0)}
                  </span>
                </div>

                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={isSavingPurchase}
                  style={{ width: '100%', padding: '10px', marginTop: 10, opacity: isSavingPurchase ? 0.7 : 1, cursor: isSavingPurchase ? 'not-allowed' : 'pointer' }}
                  onClick={async () => {
                    if (isPurchasingRef.current || isSavingPurchase) return;
                    if (!purchaseFrom) {
                      setErrors({ fromAccount: 'Please select account.' });
                      return;
                    }
                    for (let i = 0; i < purchaseItems.length; i++) {
                      const it = purchaseItems[i];
                      if (!it.name.trim()) {
                        showAppAlert(`Item #${i + 1} Name is required.`);
                        return;
                      }
                    }

                    isPurchasingRef.current = true;
                    setIsSavingPurchase(true);
                    try {
                      const finalItems = purchaseItems.map(it => {
                        const calcs = getItemCalculations(it);
                        return {
                          ...it,
                          category: it.category === 'Other' ? (it.customCategory || 'Other').trim() : (it.category || 'Groceries').trim(),
                          brand: (it.brand || '').trim(),
                          discounted_price: calcs.paidPrice,
                          price: calcs.price,
                          original_qty: calcs.parts,
                          qty: calcs.availParts,
                          pack_qty: parseFloat(it.pack_qty) || 1,
                          sub_qty: parseFloat(it.sub_qty) || 1,
                          sub_unit: it.sub_unit || 'pcs'
                        };
                      });
                      await addInventoryPurchase(purchaseFrom, purchaseDate, finalItems, purchaseNote, purchaseTime, purchaseSubAccount);
                      setShowPurchaseModal(false);
                      setPurchaseFrom('');
                      setPurchaseSubAccount('');
                      setPurchaseItems([createEmptyPurchaseItem()]);
                      await fetchItems();
                      await load();
                      showAppAlert('Purchase added successfully!');
                    } catch (err) {
                      console.error(err);
                      showAppAlert(err.message || 'Failed to save purchase.');
                    } finally {
                      isPurchasingRef.current = false;
                      setIsSavingPurchase(false);
                    }
                  }}
                >
                  {isSavingPurchase ? '⏳ Saving Purchase…' : 'Confirm Purchase'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Item Activity & Transaction History Drawer */}
        {activeActivityProduct && (
          <StockActivityDrawer
            product={activeActivityProduct}
            initialBatchId={activeActivityBatchId}
            batches={allNormalizedBatches}
            transactions={transactions}
            inventoryItems={items}
            onClose={() => {
              setActiveActivityProduct(null);
              setActiveActivityBatchId(null);
            }}
          />
        )}

        {/* Custom App Popup / Alerts with Mobile Safe Area Protection */}
        {popup && (
          <div className="stock-alert-modal-backdrop">
            <div className="stock-alert-dialog animate-pop">
              <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', marginBottom: 12, lineHeight: 1.4 }}>
                {popup.message}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                {popup.type === 'confirm' && (
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => {
                      if (popup.onCancel) popup.onCancel();
                      setPopup(null);
                    }}
                  >
                    Cancel
                  </button>
                )}
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    if (popup.onConfirm) popup.onConfirm();
                    setPopup(null);
                  }}
                >
                  OK
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
