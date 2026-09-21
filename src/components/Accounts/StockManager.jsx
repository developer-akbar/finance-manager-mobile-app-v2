import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, normalizeSuggestionQuery } from '../../utils/format.js';
import { calculateLifetimePurchaseSavings } from '../../utils/stockInventorySavings.js';
import {
  extractNormalizedBatchesFromTransactions,
  groupBatchesByProduct,
  getCanonicalProductName,
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
  const { state, load } = useApp();
  const { accounts, categories, transactions } = state;

  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('in_stock'); // 'in_stock', 'out_of_stock', 'all'
  const [search, setSearch] = useState('');
  
  // Product Detail View state
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState('all');

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
  const [consumeDate, setConsumeDate] = useState(new Date().toISOString().split('T')[0]);
  const [consumeTime, setConsumeTime] = useState('');
  const [consumeUnitMode, setConsumeUnitMode] = useState('pack'); // 'pack' or 'sub'
  const [consumeCategory, setConsumeCategory] = useState('To Home');
  const [consumeSubcategory, setConsumeSubcategory] = useState('Groceries');
  const [usageType, setUsageType] = useState('consume'); // 'consume' or 'lend' or 'instalment'
  const [instalmentMonths, setInstalmentMonths] = useState('3');
  const [personName, setPersonName] = useState('');
  const [consumeError, setConsumeError] = useState('');

  // Purchase modal states
  const [showPurchaseModal, setShowPurchaseModal] = useState(false);
  const [showAccountPicker, setShowAccountPicker] = useState(false);
  const [purchaseFrom, setPurchaseFrom] = useState('');
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
        const matchStore = p.batches.some(b => (b.source || '').toLowerCase().includes(q));
        return matchName || matchCategory || matchBrand || matchVariant || matchStore;
      }
      return true;
    });
  }, [canonicalProducts, filter, search]);

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

      // Header row with comprehensive history
      dataRows.push([
        'Product', 'Variant', 'Purchase Date', 'Store / Source', 'Purchased Qty',
        'Consumed Qty', 'Remaining Qty', 'Unit Price (₹)', 'MRP (₹)', 'Paid Amount (₹)',
        'Saved Amount (₹)', 'Status'
      ]);

      allNormalizedBatches.forEach(b => {
        dataRows.push([
          b.canonicalProduct,
          b.variant,
          b.purchasedDate || '',
          b.source || '',
          b.purchasedQty,
          b.consumedQty,
          b.remainingQty,
          Number(b.unitPrice.toFixed(2)),
          Number(b.mrp.toFixed(2)),
          Number(b.paid.toFixed(2)),
          Number(b.savings.toFixed(2)),
          b.remainingQty > 0 ? 'Available' : 'Unavailable'
        ]);
      });

      const ws = XLSX.utils.aoa_to_sheet(dataRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Stock History');

      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'binary' });
      const buf = new ArrayBuffer(wbout.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < wbout.length; i++) view[i] = wbout.charCodeAt(i) & 0xFF;

      const blob = new Blob([buf], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Stock-Inventory-History_${new Date().toISOString().split('T')[0]}.xlsx`;
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
      backInterceptRef.current = () => {};
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
  }, [showPurchaseModal, consumingItemId, editingBatchId, selectedProduct, onBack, backInterceptRef, isSavingConsume, isSavingPurchase, isSavingEdit]);

  // Escape key handler to close popup/modals
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (isSavingConsume || isSavingPurchase || isSavingEdit) {
          return; // Prevent dismissal during saving
        }
        if (showPurchaseModal) {
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
  }, [showPurchaseModal, consumingItemId, editingBatchId, selectedProduct, isSavingConsume, isSavingPurchase, isSavingEdit]);

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
      if (key && !map.has(key)) {
        map.set(key, {
          name: it.name,
          category: it.category || '',
          brand: it.brand || '',
          sub_qty: String(it.sub_qty || 1),
          sub_unit: it.sub_unit || 'pcs'
        });
      }
    });
    (allNormalizedBatches || []).forEach(b => {
      const key = (b.canonicalProduct || b.cleanedName || b.name || '').toLowerCase().trim();
      if (key && !map.has(key)) {
        map.set(key, {
          name: b.canonicalProduct || b.cleanedName || b.name,
          category: b.category || '',
          brand: b.brand || '',
          sub_qty: String(b.sub_qty || 1),
          sub_unit: b.sub_unit || 'pcs'
        });
      }
    });
    return map;
  }, [allNormalizedBatches, items]);

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

  const itemSuggestions = useMemo(() => {
    return [...new Set(allNormalizedBatches.map(i => i.cleanedName || i.rawName))];
  }, [allNormalizedBatches]);

  const storeSuggestions = useMemo(() => {
    return [...new Set(allNormalizedBatches.map(i => i.source).filter(Boolean))];
  }, [allNormalizedBatches]);

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
    const dbItem = items.find(i => i.id === batch.id) || items.find(i => (i.name || '').toLowerCase() === targetName);
    const itemId = dbItem ? dbItem.id : (batch.id || batch.txnId);

    setConsumingItemId(itemId);
    setConsumingBatch(batch);
    setConsumingItemName(batch.cleanedName || batch.name);
    setConsumingItemBatchDate(batch.purchasedDate || '');
    setConsumeQty(String(Math.min(1, batch.remainingQty > 0 ? batch.remainingQty : 1)));
    setConsumeUserNote('');
    setConsumeDate(new Date().toISOString().split('T')[0]);
    setConsumeTime(new Date().toLocaleTimeString('en-IN', { hour12: false }).slice(0, 5));
    setConsumeUnitMode('pack');
    setConsumeCategory('To Home');
    setConsumeSubcategory('Groceries');
    setUsageType('consume');
    setPersonName('');
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
      await consumeInventoryItem(
        consumingItemId,
        qty,
        consumeDate,
        consumeUnitMode === 'sub',
        consumeCategory,
        consumeSubcategory,
        usageType,
        personName,
        parseInt(instalmentMonths) || 3,
        consumeTime,
        consumeUserNote,
        consumingBatch
      );
      setConsumingItemId(null);
      setConsumingBatch(null);
      setConsumeQty('');
      setPersonName('');
      setConsumeUserNote('');
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

    let discountType = 'percentage';
    let discountValue = '0';
    if (originalPrice > 0 && finalPrice < originalPrice) {
      discountValue = String(Number((((originalPrice - finalPrice) / originalPrice) * 100).toFixed(2)));
    }

    setEditingBatchId(batch.id || batch.txnId);
    setEditFormData({
      id: batch.id || batch.txnId,
      name: batch.cleanedName || batch.name,
      category: DEFAULT_STOCK_CATEGORIES.includes(batch.category) ? batch.category : (batch.category ? 'Other' : 'Groceries'),
      customCategory: !DEFAULT_STOCK_CATEGORIES.includes(batch.category) && batch.category ? batch.category : '',
      brand: batch.brand || '',
      sub_qty: String(batch.sub_qty || 1),
      sub_unit: batch.sub_unit || 'pcs',
      pack_qty: String(batch.pack_qty || 1),
      original_qty: String(totalParts),
      qty: String(batch.remainingQty !== undefined ? batch.remainingQty : batch.qty),
      price: String(originalPrice),
      discountType,
      discountValue,
      notes: batch.source || batch.notes || '',
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
      } else {
        finalPrice = discVal || price;
      }
      const totalParts = parseFloat(editFormData.original_qty) || 1;
      const unitPrice = totalParts > 0 ? (finalPrice / totalParts) : finalPrice;
      const finalCat = editFormData.category === 'Other' ? (editFormData.customCategory || 'Other').trim() : (editFormData.category || '').trim();

      await updateInventoryItem(batchId, {
        name: editFormData.name.trim(),
        category: finalCat,
        brand: (editFormData.brand || '').trim(),
        qty: parseFloat(editFormData.qty) || 0,
        unit: 'pcs',
        price: price,
        discounted_price: unitPrice,
        purchased_date: editFormData.purchased_date,
        notes: editFormData.notes.trim(),
        sub_qty: parseFloat(editFormData.sub_qty) || 1,
        sub_unit: editFormData.sub_unit,
        original_qty: totalParts,
        pack_qty: parseFloat(editFormData.pack_qty) || 1,
        discount_type: editFormData.discountType,
        discount_value: parseFloat(editFormData.discountValue) || 0
      });
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
              if (selectedProduct) {
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
              {/* Lifetime Product Summary Card */}
              <div className="stock-prod-summary-grid">
                <div className="stock-prod-stat-item">
                  <div className="stock-prod-stat-label">Purchased</div>
                  <div className="stock-prod-stat-value">{formatFraction(activeProductData.totalPurchasedQty)}</div>
                  {activeProductPhysical?.hasPhysicalData && activeProductPhysical.purchasedDisplay && (
                    <div className="stock-prod-stat-phys">{activeProductPhysical.purchasedDisplay}</div>
                  )}
                </div>
                <div className="stock-prod-stat-item">
                  <div className="stock-prod-stat-label">Consumed</div>
                  <div className="stock-prod-stat-value" style={{ color: 'var(--text-muted)' }}>{formatFraction(activeProductData.totalConsumedQty)}</div>
                  {activeProductPhysical?.hasPhysicalData && activeProductPhysical.consumedDisplay && (
                    <div className="stock-prod-stat-phys" style={{ color: 'var(--text-muted)' }}>{activeProductPhysical.consumedDisplay}</div>
                  )}
                </div>
                <div className="stock-prod-stat-item">
                  <div className="stock-prod-stat-label">Available</div>
                  <div className="stock-prod-stat-value" style={{ color: 'var(--green)' }}>{formatFraction(activeProductData.totalRemainingQty)}</div>
                  {activeProductPhysical?.hasPhysicalData && activeProductPhysical.remainingDisplay && (
                    <div className="stock-prod-stat-phys" style={{ color: activeProductData.totalRemainingQty > 0 ? 'var(--green)' : 'var(--text-muted)' }}>
                      {activeProductPhysical.remainingDisplay}
                    </div>
                  )}
                </div>
                <div className="stock-prod-stat-item">
                  <div className="stock-prod-stat-label">Total MRP</div>
                  <div className="stock-prod-stat-value">{formatINR(activeProductData.totalMRP)}</div>
                </div>
                <div className="stock-prod-stat-item">
                  <div className="stock-prod-stat-label">Total Paid</div>
                  <div className="stock-prod-stat-value">{formatINR(activeProductData.totalPaid)}</div>
                </div>
                <div className="stock-prod-stat-item" title="Item-level MRP savings for this product">
                  <div className="stock-prod-stat-label">Product Saved</div>
                  <div className="stock-prod-stat-value" style={{ color: activeProductData.totalSavings < 0 ? 'var(--red, #ef4444)' : 'var(--green)' }}>
                    {activeProductData.totalSavings < 0 ? `-₹${Math.abs(Math.round(activeProductData.totalSavings))}` : formatINR(activeProductData.totalSavings)} <span style={{ fontSize: '0.62rem' }}>({activeProductData.savingsPct}%)</span>
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
                      <th>Date</th>
                      <th>Variant</th>
                      <th>Source</th>
                      <th>Purchased</th>
                      <th>MRP</th>
                      <th>Paid</th>
                      <th>Saved</th>
                      <th>Consumed</th>
                      <th>Remaining</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeProductBatches.map((batch, bIdx) => {
                      const isAvail = batch.remainingQty > 0;
                      return (
                        <tr key={batch.id || `${batch.purchasedDate}_${bIdx}`}>
                          <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                            📅 {batch.purchasedDate || 'Unknown'}
                          </td>
                          <td>
                            <span className="stock-badge variant">{batch.variant}</span>
                          </td>
                          <td>
                            {batch.source ? <span className="stock-badge store">{batch.source}</span> : '-'}
                          </td>
                          <td style={{ fontWeight: 700 }}>
                            {formatFraction(batch.purchasedQty)}
                          </td>
                          <td>₹{batch.mrp}</td>
                          <td style={{ fontWeight: 700 }}>₹{batch.paid}</td>
                          <td style={{ color: batch.savings < 0 ? 'var(--red, #ef4444)' : 'var(--green)' }}>
                            {batch.savings < 0 ? `-₹${Math.abs(batch.savings)}` : `₹${batch.savings}`}
                          </td>
                          <td style={{ color: 'var(--text-muted)' }}>{formatFraction(batch.consumedQty)}</td>
                          <td style={{ fontWeight: 800, color: isAvail ? 'var(--green)' : 'var(--text-muted)' }}>
                            {formatFraction(batch.remainingQty)}
                          </td>
                          <td>
                            <span className={`stock-badge ${isAvail ? 'available' : 'unavailable'}`}>
                              {isAvail ? 'In Stock' : 'Out'}
                            </span>
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 4 }}>
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
                {activeProductBatches.map((batch, bIdx) => {
                  const isAvail = batch.remainingQty > 0;
                  return (
                    <div key={batch.id || `${batch.purchasedDate}_${bIdx}`} className="stock-batch-row">
                      <div className="stock-batch-meta">
                        <span style={{ fontWeight: 700 }}>
                          📅 {batch.purchasedDate || 'Unknown Date'}
                          {batch.source && ` @ ${batch.source}`}
                        </span>
                        <span className={`stock-badge ${isAvail ? 'available' : 'unavailable'}`}>
                          {isAvail ? `${formatFraction(batch.remainingQty)} avail` : 'Consumed'}
                        </span>
                      </div>
                      <div className="stock-batch-meta">
                        <span className="stock-badge variant">{batch.variant}</span>
                        <span>Paid: <strong>₹{batch.paid}</strong> <span style={{ color: 'var(--text-muted)', fontSize: '0.62rem' }}>(MRP ₹{batch.mrp})</span></span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                        <span style={{ fontSize: '0.65rem', color: batch.savings < 0 ? 'var(--red, #ef4444)' : 'var(--green)' }}>
                          {batch.savings < 0 ? `Variance -₹${Math.abs(batch.savings)}` : `Saved ₹${batch.savings}`}
                        </span>
                        <div style={{ display: 'flex', gap: 6 }}>
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
                        <div className="stock-item-qty-col">
                          <div className={`stock-item-qty ${isOut ? 'out' : ''}`} style={{ fontSize: '0.82rem', fontWeight: 900 }}>
                            {isOut ? 'Out of Stock' : `${formatFraction(prod.totalRemainingQty)} in stock`}
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

        {/* Inline Edit Modal */}
        {editingBatchId && (
          <div
            className="stock-batch-row animate-pop"
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '90%',
              maxWidth: '420px',
              gap: 8,
              padding: 16,
              zIndex: 1000,
              background: 'var(--bg-card)',
              borderRadius: '12px',
              border: '1.5px solid var(--accent)',
              boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.5)',
              maxHeight: '90vh',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <div className="stock-builder-lbl" style={{ color: 'var(--accent)', fontWeight: 800, marginBottom: 4 }}>
              Edit Batch Details
            </div>

            {/* Purchase Date & Time */}
            <div className="stock-row-grid-2">
              <div className="mgr-edit-field">
                <label className="stock-builder-lbl">Purchase Date</label>
                <input
                  type="date"
                  className="form-input"
                  style={{ width: '100%' }}
                  value={editFormData.purchased_date}
                  onChange={e => setEditFormData({ ...editFormData, purchased_date: e.target.value })}
                />
              </div>
              <div className="mgr-edit-field">
                <label className="stock-builder-lbl">Store / Source</label>
                <input
                  type="text"
                  className="form-input"
                  style={{ width: '100%' }}
                  value={editFormData.notes}
                  onChange={e => setEditFormData({ ...editFormData, notes: e.target.value })}
                />
              </div>
            </div>

            {/* Item Name */}
            <div className="mgr-edit-field">
              <label className="stock-builder-lbl">Item Name</label>
              <input
                type="text"
                className="form-input"
                style={{ width: '100%' }}
                value={editFormData.name}
                onChange={e => setEditFormData({ ...editFormData, name: e.target.value })}
              />
            </div>

            {/* Category & Brand */}
            <div className="stock-row-grid-2">
              <div className="mgr-edit-field">
                <label className="stock-builder-lbl">Category</label>
                <select
                  className="form-input"
                  value={editFormData.category || 'Groceries'}
                  onChange={e => setEditFormData({ ...editFormData, category: e.target.value })}
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
                    onChange={e => setEditFormData({ ...editFormData, customCategory: e.target.value })}
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
                  onChange={e => setEditFormData({ ...editFormData, brand: e.target.value })}
                />
              </div>
            </div>

            {/* Pack Size & Unit & Qty */}
            <div className="stock-row-grid-3">
              <div className="mgr-edit-field">
                <label className="stock-builder-lbl">Pack Size</label>
                <input
                  type="number"
                  step="any"
                  className="form-input"
                  value={editFormData.sub_qty}
                  onChange={e => setEditFormData({ ...editFormData, sub_qty: e.target.value })}
                />
              </div>
              <div className="mgr-edit-field">
                <label className="stock-builder-lbl">Pack Unit</label>
                <select
                  className="form-input"
                  value={normalizeUnit(editFormData.sub_unit)}
                  onChange={e => setEditFormData({ ...editFormData, sub_unit: e.target.value })}
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
              <div className="mgr-edit-field">
                <label className="stock-builder-lbl">Total Parts</label>
                <input
                  type="number"
                  step="any"
                  className="form-input"
                  value={editFormData.original_qty}
                  onChange={e => setEditFormData({ ...editFormData, original_qty: e.target.value })}
                />
              </div>
            </div>

            {/* Parts & Available Parts */}
            <div className="stock-row-grid-2">
              <div className="mgr-edit-field">
                <label className="stock-builder-lbl">Available Parts</label>
                <input
                  type="number"
                  step="any"
                  className="form-input"
                  value={editFormData.qty}
                  onChange={e => setEditFormData({ ...editFormData, qty: e.target.value })}
                />
              </div>
              <div className="mgr-edit-field">
                <label className="stock-builder-lbl">Original Price (₹)</label>
                <input
                  type="number"
                  step="any"
                  className="form-input"
                  value={editFormData.price}
                  onChange={e => setEditFormData({ ...editFormData, price: e.target.value })}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="stock-btn-action consume" onClick={() => handleSaveEditBatch(editingBatchId)}>Save</button>
              <button className="stock-btn-action" onClick={() => setEditingBatchId(null)}>Cancel</button>
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
              maxWidth: '420px',
              gap: 8,
              padding: 16,
              zIndex: 1000,
              background: 'var(--bg-card)',
              borderRadius: '12px',
              border: '1.5px solid var(--accent)',
              boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.5)',
              maxHeight: '90vh',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <div className="stock-builder-lbl" style={{ color: 'var(--accent)', fontWeight: 800, marginBottom: 4 }}>
              Use Item: {consumingItemName} ({consumingItemBatchDate || 'Batch'})
            </div>

            {isSavingConsume && (
              <div className="stock-saving-banner">
                <span>⏳</span>
                <span>Saving stock usage… Please wait.</span>
              </div>
            )}

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

            <div style={{ display: 'flex', gap: 6, width: '100%', marginBottom: 4 }}>
              <button
                type="button"
                className="stock-btn-action"
                disabled={isSavingConsume}
                style={{
                  flex: 1,
                  background: usageType === 'consume' ? 'var(--blue-bg)' : 'var(--bg-card2)',
                  color: usageType === 'consume' ? 'var(--blue)' : 'var(--text-primary)',
                  borderColor: usageType === 'consume' ? 'rgba(77, 159, 255, 0.2)' : 'var(--border)',
                  opacity: isSavingConsume ? 0.6 : 1
                }}
                onClick={() => setUsageType('consume')}
              >
                🍽️ Consume
              </button>
              <button
                type="button"
                className="stock-btn-action"
                disabled={isSavingConsume}
                style={{
                  flex: 1,
                  background: usageType === 'lend' ? 'rgba(255, 179, 0, 0.15)' : 'var(--bg-card2)',
                  color: usageType === 'lend' ? 'var(--gold)' : 'var(--text-primary)',
                  borderColor: usageType === 'lend' ? 'rgba(255, 179, 0, 0.2)' : 'var(--border)',
                  opacity: isSavingConsume ? 0.6 : 1
                }}
                onClick={() => setUsageType('lend')}
              >
                🤝 Lend
              </button>
              <button
                type="button"
                className="stock-btn-action"
                disabled={isSavingConsume}
                style={{
                  flex: 1,
                  background: usageType === 'instalment' ? 'rgba(255, 179, 0, 0.15)' : 'var(--bg-card2)',
                  color: usageType === 'instalment' ? 'var(--gold)' : 'var(--text-primary)',
                  borderColor: usageType === 'instalment' ? 'rgba(255, 179, 0, 0.2)' : 'var(--border)',
                  opacity: isSavingConsume ? 0.6 : 1
                }}
                onClick={() => setUsageType('instalment')}
              >
                📋 Instalment
              </button>
            </div>

            <div className="mgr-edit-field">
              <label className="stock-builder-lbl">Quantity to Use</label>
              <input
                type="number"
                step="any"
                disabled={isSavingConsume}
                className={`form-input ${consumeError ? 'err' : ''}`}
                value={consumeQty}
                onChange={e => {
                  setConsumeQty(e.target.value);
                  setConsumeError('');
                }}
              />
            </div>

            <div className="mgr-edit-field">
              <label className="stock-builder-lbl">Note (Optional)</label>
              <NoteAutocompleteInput
                value={consumeUserNote}
                disabled={isSavingConsume}
                onChange={setConsumeUserNote}
                transactions={transactions}
              />
            </div>

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
                  onChange={e => {
                    setPersonName(e.target.value);
                    setActiveLendSug(true);
                  }}
                />
                {!isSavingConsume && activeLendSug && debtPeople.filter(p => p.toLowerCase().includes(personName.toLowerCase())).length > 0 && (
                  <div className="note-sug-list" style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 100, maxHeight: 100, overflowY: 'auto' }}>
                    {debtPeople.filter(p => p.toLowerCase().includes(personName.toLowerCase())).map(item => (
                      <div
                        key={item}
                        className="note-sug-item"
                        onMouseDown={() => {
                          setPersonName(item);
                          setActiveLendSug(false);
                        }}
                        style={{ fontSize: '0.72rem', padding: '6px 8px', cursor: 'pointer' }}
                      >
                        {item}
                      </div>
                    ))}
                  </div>
                )}
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

            {consumeError && <div className="field-error">{consumeError}</div>}

            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button
                className="stock-btn-action consume"
                disabled={isSavingConsume}
                style={{ opacity: isSavingConsume ? 0.7 : 1, cursor: isSavingConsume ? 'not-allowed' : 'pointer' }}
                onClick={handleConsume}
              >
                {isSavingConsume ? '⏳ Saving Stock Usage…' : 'Confirm'}
              </button>
              <button
                className="stock-btn-action"
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
            <div className="stock-purchase-content" onClick={e => e.stopPropagation()}>
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

                <div className="form-group" style={{ position: 'relative' }}>
                  <label className="stock-builder-lbl">Paid From</label>
                  <button
                    type="button"
                    className="picker-trigger"
                    style={{ textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowAccountPicker(!showAccountPicker);
                    }}
                  >
                    <span>{purchaseFrom || 'Select Account...'}</span>
                    <span style={{ fontSize: '0.7rem', opacity: 0.7 }}>▼</span>
                  </button>
                  {showAccountPicker && (
                    <div className="note-sug-list" style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 100, maxHeight: 180, overflowY: 'auto' }}>
                      {accountList.map(accName => (
                        <div
                          key={accName}
                          className="note-sug-item"
                          onMouseDown={() => {
                            setPurchaseFrom(accName);
                            setShowAccountPicker(false);
                          }}
                          style={{ fontSize: '0.8rem', padding: '8px 12px', cursor: 'pointer' }}
                        >
                          {accName}
                        </div>
                      ))}
                    </div>
                  )}
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
                          <div className="note-sug-list" style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 100, maxHeight: 140, overflowY: 'auto' }}>
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

                      {/* Calculated Metrics Live Preview */}
                      <div className="stock-item-calc-preview">
                        <div className="stock-calc-col">
                          <span className="stock-calc-lbl">Paid Price</span>
                          <span className="stock-calc-val paid">{formatINR(calcs.paidPrice)}</span>
                        </div>
                        <div className="stock-calc-col">
                          <span className="stock-calc-lbl">Price / Unit</span>
                          <span className="stock-calc-val">{formatINR(calcs.pricePerUnit)}</span>
                        </div>
                        <div className="stock-calc-col">
                          <span className="stock-calc-lbl">Remaining Value</span>
                          <span className="stock-calc-val avail">{formatINR(calcs.remainingValue)}</span>
                        </div>
                        {calcs.saved > 0 && (
                          <div className="stock-calc-col">
                            <span className="stock-calc-lbl">Saved</span>
                            <span className="stock-calc-val" style={{ color: 'var(--green)' }}>{formatINR(calcs.saved)}</span>
                          </div>
                        )}
                      </div>

                      {/* Source: Store Name */}
                      <div className="mgr-edit-field">
                        <label className="stock-builder-lbl">Store Name</label>
                        <input
                          type="text"
                          className="form-input"
                          placeholder="e.g. DMart, Amazon"
                          value={item.notes}
                          onChange={e => updatePurchaseItem(item._id, 'notes', e.target.value)}
                        />
                      </div>
                    </div>
                  );
                })}

                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ width: '100%', padding: '8px' }}
                  onClick={() => setPurchaseItems(prev => [...prev, createEmptyPurchaseItem()])}
                >
                  ➕ Add Another Item
                </button>

                <div className="grand-total-section">
                  <span>Grand Total:</span>
                  <span style={{ fontWeight: 800, color: 'var(--green)', fontSize: '1rem' }}>
                    {formatINR(totalPurchaseSum)}
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
                      await addInventoryPurchase(purchaseFrom, purchaseDate, finalItems, purchaseNote, purchaseTime);
                      setShowPurchaseModal(false);
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
