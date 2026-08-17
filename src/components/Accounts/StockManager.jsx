import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR } from '../../utils/format.js';
import {
  getInventoryItems,
  addInventoryPurchase,
  consumeInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  syncStockFromPastTransactions
} from '../../database/inventory.js';
import './StockManager.css';

const getEmoji = (name) => {
  const n = name.toLowerCase();
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

export default function StockManager({ onBack, backInterceptRef }) {
  const { state, load } = useApp();
  const { accounts, categories, transactions } = state;

  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('in_stock'); // 'in_stock', 'out_of_stock', 'all'
  const [search, setSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState({});

  const [popup, setPopup] = useState(null);

  const showAppAlert = (message, onConfirm = null) => {
    setPopup({ type: 'alert', message, onConfirm });
  };

  const showAppConfirm = (message, onConfirm, onCancel = null) => {
    setPopup({ type: 'confirm', message, onConfirm, onCancel });
  };

  // Inline edit state
  const [editingBatchId, setEditingBatchId] = useState(null);
  const [editFormData, setEditFormData] = useState({});
  const [activeStoreEditSug, setActiveStoreEditSug] = useState(false);

  // Suggestions active index states (inline custom autocomplete popover)
  const [activeItemSugIdx, setActiveItemSugIdx] = useState(null);
  const [activeStoreSugIdx, setActiveStoreSugIdx] = useState(null);
  const [activeLendSug, setActiveLendSug] = useState(false);

  // Consumption states
  const [consumingItemId, setConsumingItemId] = useState(null);
  const [consumeQty, setConsumeQty] = useState('');
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
  const [purchaseItems, setPurchaseItems] = useState([
    { name: '', sub_qty: '1', sub_unit: 'pcs', pack_qty: '1', original_qty: '1', qty: '1', price: '', discountType: 'percentage', discountValue: '', notes: '' }
  ]);
  const [errors, setErrors] = useState({});
  const [syncing, setSyncing] = useState(false);

  const handleExportExcel = async () => {
    try {
      const XLSX = await import('xlsx');
      const dataRows = [];

      // Header row matching Stock-Inventory.xlsx exactly
      dataRows.push([
        'Date', 'Product', 'Qty', 'Item Price', 'Items', 'Parts',
        'Available Parts', 'Actual Price', 'Final Price', 'Cashback',
        'Source', 'Status', '%'
      ]);

      items.forEach(b => {
        const availableParts = parseFloat(b.qty) || 0;
        const subQty = parseFloat(b.sub_qty) || 1;
        const originalPrice = parseFloat(b.price) || 0; // Actual Price of batch
        const unitPrice = parseFloat(b.discounted_price) || originalPrice; // Price per part
        const packQty = parseFloat(b.pack_qty) || 1;
        const totalParts = parseFloat(b.original_qty) || b.qty || 1;

        const finalPrice = totalParts * unitPrice; // Final Price paid
        const cb = Math.max(0, originalPrice - finalPrice);
        const pct = originalPrice > 0 ? cb / originalPrice : 0;

        dataRows.push([
          b.purchased_date || '',
          b.name,
          b.sub_unit ? `${subQty}${b.sub_unit}` : 'NA',
          unitPrice,
          packQty,
          totalParts,
          availableParts,
          originalPrice,
          finalPrice,
          cb,
          b.notes || '',
          availableParts > 0 ? 'Available' : 'Unavailable',
          pct
        ]);
      });

      const ws = XLSX.utils.aoa_to_sheet(dataRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Stock');

      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'binary' });
      const buf = new ArrayBuffer(wbout.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < wbout.length; i++) view[i] = wbout.charCodeAt(i) & 0xFF;

      const blob = new Blob([buf], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Stock-Inventory_${new Date().toISOString().split('T')[0]}.xlsx`;
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
    if (showPurchaseModal) {
      backInterceptRef.current = () => setShowPurchaseModal(false);
    } else if (consumingItemId) {
      backInterceptRef.current = () => {
        setConsumingItemId(null);
        setConsumeError('');
      };
    } else if (editingBatchId) {
      backInterceptRef.current = () => setEditingBatchId(null);
    } else {
      backInterceptRef.current = onBack;
    }
    return () => {
      if (backInterceptRef) backInterceptRef.current = onBack;
    };
  }, [showPurchaseModal, consumingItemId, editingBatchId, onBack, backInterceptRef]);

  // Escape key handler to close popup/modals
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (showPurchaseModal) {
          setShowPurchaseModal(false);
        } else if (consumingItemId) {
          setConsumingItemId(null);
          setConsumeError('');
        } else if (editingBatchId) {
          setEditingBatchId(null);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showPurchaseModal, consumingItemId, editingBatchId]);

  // Compute statistics
  const stats = useMemo(() => {
    let availableValue = 0;
    let totalSaved = 0;

    items.forEach(item => {
      const qty = parseFloat(item.qty) || 0;
      const price = parseFloat(item.price) || 0;
      const discPrice = parseFloat(item.discounted_price) || price;
      const origQty = parseFloat(item.original_qty || item.qty) || 0;

      availableValue += qty * discPrice;
      totalSaved += origQty * Math.max(0, price - discPrice);
    });

    // Sum transactions transferring funds TO Stock
    let totalPurchased = 0;
    (transactions || []).forEach(t => {
      if (t.ToAccount === 'Stock') {
        totalPurchased += parseFloat(t.INR || t.Amount || 0);
      }
    });

    const totalCostAndSavings = totalPurchased + totalSaved;
    const savedPct = totalCostAndSavings > 0
      ? ((totalSaved / totalCostAndSavings) * 100).toFixed(1)
      : '0.0';

    return {
      totalPurchased,
      totalSaved,
      savedPct,
      availableValue
    };
  }, [items, transactions]);

  // Group items by name (case-insensitive) for accordion layout
  const groupedItems = useMemo(() => {
    const groups = {};
    items.forEach(item => {
      const qty = parseFloat(item.qty) || 0;

      // Filter individual batches based on tab
      if (filter === 'in_stock' && qty === 0) return;
      if (filter === 'out_of_stock' && qty > 0) return;

      const key = item.name.toLowerCase().trim();
      if (!groups[key]) {
        groups[key] = {
          key,
          name: item.name,
          totalQty: 0,
          unit: item.unit || 'pcs',
          sub_qty: item.sub_qty || 1,
          sub_unit: item.sub_unit || '',
          availableValue: 0,
          totalVolume: 0,
          batches: []
        };
      }
      const g = groups[key];
      g.totalQty += qty;
      const price = parseFloat(item.discounted_price) || parseFloat(item.price) || 0;
      g.availableValue += qty * price;

      // Calculate batch remaining volume: remainingPacks * sub_qty
      const remPacks = (item.original_qty > 0) ? (qty / (item.original_qty / (item.pack_qty || 1))) : qty;
      g.totalVolume += remPacks * (item.sub_qty || 1);

      g.batches.push(item);
    });

    return Object.values(groups)
      .map(g => {
        g.batches.sort((a, b) => (b.purchased_date || '').localeCompare(a.purchased_date || ''));
        return g;
      })
      .sort((a, b) => {
        const dateA = a.batches[0]?.purchased_date || '';
        const dateB = b.batches[0]?.purchased_date || '';
        return dateB.localeCompare(dateA);
      })
      .filter(g => {
        const matchesSearch = g.name.toLowerCase().includes(search.toLowerCase()) ||
          g.batches.some(b => (b.notes || '').toLowerCase().includes(search.toLowerCase()));
        return matchesSearch;
      });
  }, [items, filter, search]);

  const itemSuggestions = useMemo(() => {
    return [...new Set(items.map(i => i.name))];
  }, [items]);

  const storeSuggestions = useMemo(() => {
    return [...new Set(items.map(i => i.notes).filter(Boolean))];
  }, [items]);

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

  const handleConsume = async (item) => {
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

    const subQtyVal = parseFloat(item.sub_qty) || 1;
    const isSubMode = consumeUnitMode === 'sub';
    const availableQty = isSubMode ? (item.qty * subQtyVal) : item.qty;

    if (qty > availableQty) {
      setConsumeError(`Exceeds available stock (${parseFloat(availableQty.toFixed(3))} ${isSubMode ? (item.sub_unit || 'g') : (item.unit || 'pcs')}).`);
      return;
    }

    try {
      await consumeInventoryItem(
        item.id,
        qty,
        consumeDate,
        isSubMode,
        consumeCategory,
        consumeSubcategory,
        usageType,
        personName,
        parseInt(instalmentMonths) || 3,
        consumeTime
      );
      setConsumingItemId(null);
      setConsumeQty('');
      setPersonName('');
      setConsumeTime('');
      setInstalmentMonths('3');
      setConsumeError('');
      await fetchItems();
      await load();
    } catch (err) {
      console.error(err);
      setConsumeError('Failed to record stock usage.');
    }
  };

  const handleAddNewPurchaseItem = () => {
    const firstItem = purchaseItems[0] || {};
    setPurchaseItems(prev => [
      ...prev,
      {
        name: '',
        sub_qty: '1',
        sub_unit: 'pcs',
        pack_qty: '1',
        original_qty: '1',
        qty: '1',
        price: '',
        discountType: firstItem.discountType || 'percentage',
        discountValue: firstItem.discountValue || '',
        notes: firstItem.notes || ''
      }
    ]);
  };

  const handleRemovePurchaseItem = (index) => {
    setPurchaseItems(prev => prev.filter((_, i) => i !== index));
  };

  const handlePurchaseItemChange = (index, field, val) => {
    setPurchaseItems(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: val };
      return next;
    });

    if (errors[`item_${index}`]?.[field]) {
      setErrors(prev => {
        const copy = { ...prev };
        if (copy[`item_${index}`]) {
          delete copy[`item_${index}`][field];
          if (Object.keys(copy[`item_${index}`]).length === 0) {
            delete copy[`item_${index}`];
          }
        }
        return copy;
      });
    }
  };

  const handleSavePurchase = async () => {
    const newErrors = {};
    if (!purchaseFrom) {
      newErrors.purchaseFrom = 'Please select a payment account.';
    }

    const validItems = [];
    purchaseItems.forEach((item, idx) => {
      const itemErr = {};
      if (!item.name.trim()) {
        itemErr.name = 'Required.';
      }

      const subQty = parseFloat(item.sub_qty);
      if (isNaN(subQty) || subQty <= 0) {
        itemErr.sub_qty = 'Required and > 0.';
      }

      if (!item.sub_unit) {
        itemErr.sub_unit = 'Required.';
      }

      const packQty = parseFloat(item.pack_qty);
      if (isNaN(packQty) || packQty <= 0) {
        itemErr.pack_qty = 'Required and > 0.';
      }

      const partsVal = parseFloat(item.original_qty);
      if (isNaN(partsVal) || partsVal <= 0) {
        itemErr.original_qty = 'Required and > 0.';
      }

      const remainingParts = parseFloat(item.qty);
      if (isNaN(remainingParts) || remainingParts < 0) {
        itemErr.qty = 'Required and >= 0.';
      }

      const price = parseFloat(item.price);
      if (isNaN(price) || price <= 0) {
        itemErr.price = 'Required and > 0.';
      }

      const discVal = parseFloat(item.discountValue);
      if (isNaN(discVal) || discVal < 0) {
        itemErr.discountValue = 'Required and >= 0.';
      }

      if (!item.notes.trim()) {
        itemErr.notes = 'Required.';
      }

      if (Object.keys(itemErr).length > 0) {
        newErrors[`item_${idx}`] = itemErr;
      } else {
        const finalPrice = calculateDiscountedPrice(item);
        validItems.push({
          name: item.name.trim(),
          qty: remainingParts,
          unit: 'pcs',
          price: price,
          discounted_price: finalPrice,
          notes: item.notes.trim(),
          sub_qty: subQty,
          sub_unit: item.sub_unit.trim(),
          original_qty: partsVal,
          pack_qty: packQty
        });
      }
    });

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    try {
      await addInventoryPurchase(purchaseFrom, purchaseDate, validItems, purchaseNote, purchaseTime);
      setShowPurchaseModal(false);
      setShowAccountPicker(false);
      setErrors({});
      setPurchaseItems([{ name: '', sub_qty: '1', sub_unit: 'pcs', pack_qty: '1', original_qty: '1', qty: '1', price: '', discountType: 'percentage', discountValue: '', notes: '' }]);
      setPurchaseNote('in stock');
      setPurchaseTime(new Date().toLocaleTimeString('en-IN', { hour12: false }).slice(0, 5));
      await fetchItems();
      await load();
    } catch (err) {
      console.error(err);
      showAppAlert('Failed to save purchase.');
    }
  };

  const handleStartEditBatch = (batch) => {
    setEditingBatchId(batch.id);

    // Calculate initial discount values
    const originalPrice = parseFloat(batch.price) || 0;
    const totalParts = parseFloat(batch.original_qty || batch.qty) || 1;
    const unitPrice = parseFloat(batch.discounted_price || batch.price || 0);
    const finalPrice = totalParts * unitPrice;

    let discountType = batch.discount_type || 'percentage';
    let discountValue = '0';

    if (batch.discount_type === 'percentage' || batch.discount_type === 'value') {
      discountValue = String(Number(parseFloat(batch.discount_value || 0).toFixed(2)));
    } else {
      if (originalPrice > 0) {
        const diff = originalPrice - finalPrice;
        if (diff > 0) {
          discountType = 'percentage';
          discountValue = String(Number(((diff / originalPrice) * 100).toFixed(2)));
        }
      }
    }

    setEditFormData({
      name: batch.name,
      sub_qty: String(batch.sub_qty || 1),
      sub_unit: batch.sub_unit || 'pcs',
      pack_qty: String(batch.pack_qty || 1),
      original_qty: String(totalParts),
      qty: String(batch.qty),
      price: String(originalPrice),
      discountType,
      discountValue,
      notes: batch.notes || '',
      purchased_date: batch.purchased_date || ''
    });
  };

  const handleSaveEditBatch = async (batchId) => {
    // Validate fields are mandatory
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
    if (isNaN(parseFloat(editFormData.pack_qty)) || parseFloat(editFormData.pack_qty) <= 0) {
      showAppAlert('Qty (Packs) must be greater than 0.');
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
    if (isNaN(parseFloat(editFormData.discountValue)) || parseFloat(editFormData.discountValue) < 0) {
      showAppAlert('Discount value is required.');
      return;
    }
    if (!editFormData.notes.trim()) {
      showAppAlert('Store Name is required.');
      return;
    }

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

      await updateInventoryItem(batchId, {
        name: editFormData.name.trim(),
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
    } catch (err) {
      console.error(err);
      showAppAlert('Failed to update batch details.');
    }
  };

  const handleDeleteItem = (id) => {
    showAppConfirm('Delete this stock batch?', async () => {
      try {
        await deleteInventoryItem(id);
        await fetchItems();
      } catch (err) {
        console.error(err);
        showAppAlert('Failed to delete item.');
      }
    });
  };

  const toggleGroup = (key) => {
    setExpandedGroups(prev => {
      const willCollapse = !!prev[key];
      if (willCollapse) {
        setEditingBatchId(null);
        setConsumingItemId(null);
        setConsumeError('');
      }
      return { ...prev, [key]: !prev[key] };
    });
  };

  const totalPurchaseSum = useMemo(() => {
    return purchaseItems.reduce((sum, item) => {
      const finalPrice = calculateDiscountedPrice(item);
      return sum + finalPrice;
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
        />
      )}
      <div className="stock-manager-screen" onClick={() => {
        // Click outside suggestions lists to close them
        setActiveItemSugIdx(null);
        setActiveStoreSugIdx(null);
        setActiveStoreEditSug(false);
        setActiveLendSug(false);
      }}>
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack} title="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="page-hdr-title" style={{ flex: 1 }}>Stock Inventory</div>
        <button
          className="btn btn-sm btn-secondary"
          style={{ padding: '6px 10px', fontSize: '0.72rem', borderRadius: 8, marginRight: 6, display: 'flex', alignItems: 'center', gap: 4 }}
          onClick={handleExportExcel}
          title="Export Stock Report to Excel"
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
        {/* Statistics Header */}
        <div className="stock-summary-card">
          <div className="stock-summary-col">
            <div className="stock-summary-label">Total Purchased</div>
            <div className="stock-summary-val" style={{ color: 'var(--text-secondary)' }}>
              {formatINR(stats.totalPurchased)}
            </div>
          </div>
          <div className="stock-summary-divider" />
          <div className="stock-summary-col">
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

        {/* Filter bar */}
        <div className="stock-filters">
          <button
            className={`stock-filter-btn ${filter === 'in_stock' ? 'active' : ''}`}
            onClick={() => setFilter('in_stock')}
          >
            In Stock
          </button>
          <button
            className={`stock-filter-btn ${filter === 'out_of_stock' ? 'active' : ''}`}
            onClick={() => setFilter('out_of_stock')}
          >
            Out of Stock
          </button>
          <button
            className={`stock-filter-btn ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All Items
          </button>
        </div>

        {/* Search bar */}
        <div className="stock-search-bar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14" style={{ stroke: 'var(--text-muted)' }}>
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            className="stock-search-input"
            placeholder="Search items by name or store..."
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

        {/* Grouped Stock List */}
        <div className="stock-item-list">
          {groupedItems.map(group => {
            const isOut = group.totalQty <= 0;
            const isExpanded = expandedGroups[group.key];
            const avgPrice = group.totalQty > 0 ? (group.availableValue / group.totalQty) : 0;
            const containsConsumingBatch = group.batches.some(b => b.id === consumingItemId);

            return (
              <div
                key={group.key}
                className={`stock-item-card ${containsConsumingBatch ? 'consuming-active' : ''}`}
                style={containsConsumingBatch ? { position: 'relative', zIndex: 1000, background: 'var(--bg-card)', boxShadow: '0 8px 30px rgba(0,0,0,0.5)' } : {}}
                onClick={() => toggleGroup(group.key)}
              >
                <div className="stock-item-top">
                  <div className="stock-item-info">
                    <div className="stock-item-icon">{getEmoji(group.name)}</div>
                    <div className="stock-item-details" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                      <div className="stock-item-name" style={{ fontSize: '0.82rem', fontWeight: 800 }}>{group.name}</div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                        Avg Price: ₹{avgPrice.toFixed(1)} / {group.unit}
                      </div>
                    </div>
                  </div>
                  <div className="stock-item-qty-col">
                    <div className={`stock-item-qty ${isOut ? 'out' : ''}`} style={{ fontSize: '0.8rem', fontWeight: 900 }}>
                      {formatFraction(group.totalQty)} {group.unit}
                      {group.sub_unit && group.totalQty > 0 && (
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block', fontWeight: 700 }}>
                          (total: {formatFraction(group.totalVolume)} {group.sub_unit})
                        </span>
                      )}
                    </div>
                    <div className="stock-item-price" style={{ fontSize: '0.7rem', color: 'var(--accent)', fontWeight: 700, marginTop: 1 }}>
                      Value: {formatINR(group.availableValue)}
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="stock-batch-list" onClick={e => e.stopPropagation()}>
                    {group.batches.map(batch => {
                      const isConsuming = consumingItemId === batch.id;
                      const isEditing = editingBatchId === batch.id;
                      const batchCost = batch.qty * (batch.discounted_price || batch.price || 0);

                      if (isEditing) {
                        const editCost = (parseFloat(editFormData.qty) || 0) * (parseFloat(editFormData.discounted_price || editFormData.price || 0));
                        const editFinalBatchPrice = (() => {
                          const price = parseFloat(editFormData.price) || 0;
                          const discVal = parseFloat(editFormData.discountValue) || 0;
                          if (editFormData.discountType === 'percentage') {
                            return price * (1 - discVal / 100);
                          } else {
                            return discVal || price;
                          }
                        })();
                        const editTotalParts = parseFloat(editFormData.original_qty) || 1;
                        const editUnitPrice = editTotalParts > 0 ? (editFinalBatchPrice / editTotalParts) : 0;
                        const editAvailParts = parseFloat(editFormData.qty) || 0;
                        const editRemainingTotalValue = editUnitPrice * editAvailParts;

                        return (
                              <div
                                key={batch.id}
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
                            <div className="stock-builder-lbl" style={{ color: 'var(--accent)', fontWeight: 800, marginBottom: 4 }}>Edit Batch Details</div>

                            {/* Item Name */}
                            <div className="mgr-edit-field" style={{ position: 'relative' }}>
                              <label className="stock-builder-lbl">Item Name</label>
                              <input
                                type="text"
                                className="form-input"
                                style={{ width: '100%' }}
                                value={editFormData.name}
                                onFocus={() => setActiveStoreEditSug(false)}
                                onChange={e => setEditFormData({ ...editFormData, name: e.target.value })}
                              />
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
                                  onFocus={e => {
                                    setActiveStoreEditSug(false);
                                    e.target.select();
                                  }}
                                  onChange={e => setEditFormData({ ...editFormData, sub_qty: e.target.value })}
                                />
                              </div>
                              <div className="mgr-edit-field">
                                <label className="stock-builder-lbl">Pack Unit</label>
                                <select
                                  className="form-input"
                                  value={normalizeUnit(editFormData.sub_unit)}
                                  onFocus={() => setActiveStoreEditSug(false)}
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
                                <label className="stock-builder-lbl">Qty (Packs)</label>
                                <input
                                  type="number"
                                  step="any"
                                  className="form-input"
                                  value={editFormData.pack_qty}
                                  onFocus={e => {
                                    setActiveStoreEditSug(false);
                                    e.target.select();
                                  }}
                                  onChange={e => setEditFormData({ ...editFormData, pack_qty: e.target.value })}
                                />
                              </div>
                            </div>

                            {/* Parts & Available Parts */}
                            <div className="stock-row-grid-2">
                              <div className="mgr-edit-field">
                                <label className="stock-builder-lbl">Parts (n)</label>
                                <input
                                  type="number"
                                  step="any"
                                  className="form-input"
                                  value={editFormData.original_qty}
                                  onFocus={e => {
                                    setActiveStoreEditSug(false);
                                    e.target.select();
                                  }}
                                  onChange={e => {
                                    const val = e.target.value;
                                    setEditFormData(prev => {
                                      const next = { ...prev, original_qty: val };
                                      if (prev.qty === '' || prev.qty === prev.original_qty) {
                                        next.qty = val;
                                      }
                                      return next;
                                    });
                                  }}
                                />
                              </div>
                              <div className="mgr-edit-field">
                                <label className="stock-builder-lbl">Available Parts (n)</label>
                                <input
                                  type="number"
                                  step="any"
                                  className="form-input"
                                  value={editFormData.qty}
                                  onFocus={e => {
                                    setActiveStoreEditSug(false);
                                    e.target.select();
                                  }}
                                  onChange={e => setEditFormData({ ...editFormData, qty: e.target.value })}
                                />
                              </div>
                            </div>

                            {/* Original Price & Discount */}
                            <div className="stock-row-grid-2">
                              <div className="mgr-edit-field">
                                <label className="stock-builder-lbl">Original Price (₹)</label>
                                <input
                                  type="number"
                                  step="any"
                                  className="form-input"
                                  value={editFormData.price}
                                  onFocus={e => {
                                    setActiveStoreEditSug(false);
                                    e.target.select();
                                  }}
                                  onChange={e => setEditFormData({ ...editFormData, price: e.target.value })}
                                />
                              </div>
                              <div className="mgr-edit-field">
                                <label className="stock-builder-lbl">Discount</label>
                                <div style={{ display: 'flex', gap: '6px' }}>
                                  <button
                                    type="button"
                                    onClick={() => setEditFormData({ ...editFormData, discountType: 'percentage' })}
                                    style={{
                                      padding: '4px 8px',
                                      fontSize: '0.7rem',
                                      fontWeight: 800,
                                      borderRadius: '6px',
                                      border: '1px solid var(--border)',
                                      background: editFormData.discountType === 'percentage' ? 'var(--green)' : 'var(--bg-card2)',
                                      color: editFormData.discountType === 'percentage' ? '#0a0f1e' : 'var(--text-primary)',
                                      cursor: 'pointer'
                                    }}
                                  >
                                    %
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditFormData({ ...editFormData, discountType: 'value' })}
                                    style={{
                                      padding: '4px 8px',
                                      fontSize: '0.7rem',
                                      fontWeight: 800,
                                      borderRadius: '6px',
                                      border: '1px solid var(--border)',
                                      background: editFormData.discountType === 'value' ? 'var(--green)' : 'var(--bg-card2)',
                                      color: editFormData.discountType === 'value' ? '#0a0f1e' : 'var(--text-primary)',
                                      cursor: 'pointer'
                                    }}
                                  >
                                    ₹
                                  </button>
                                  <input
                                    type="number"
                                    step="any"
                                    className="form-input"
                                    style={{ flex: 1 }}
                                    placeholder={editFormData.discountType === 'percentage' ? 'Disc. %' : 'Value after disc.'}
                                    value={editFormData.discountValue}
                                    onFocus={e => {
                                      setActiveStoreEditSug(false);
                                      e.target.select();
                                    }}
                                    onChange={e => setEditFormData({ ...editFormData, discountValue: e.target.value })}
                                  />
                                </div>
                              </div>
                            </div>

                            {/* Store Name & suggestions */}
                            <div className="mgr-edit-field" style={{ position: 'relative' }}>
                              <label className="stock-builder-lbl">Store Name</label>
                              <input
                                type="text"
                                className="form-input"
                                placeholder="e.g. Amazon, DMart"
                                value={editFormData.notes}
                                onClick={e => e.stopPropagation()}
                                onFocus={() => setActiveStoreEditSug(true)}
                                onChange={e => {
                                  setEditFormData({ ...editFormData, notes: e.target.value });
                                  setActiveStoreEditSug(true);
                                }}
                              />
                              {activeStoreEditSug && storeSuggestions.filter(s => s.toLowerCase().includes((editFormData.notes || '').toLowerCase())).length > 0 && (
                                <div className="note-sug-list" style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 100, maxHeight: 120, overflowY: 'auto' }}>
                                  {storeSuggestions.filter(s => s.toLowerCase().includes((editFormData.notes || '').toLowerCase())).map(item => (
                                    <div
                                      key={item}
                                      className="note-sug-item"
                                      onMouseDown={() => {
                                        setEditFormData(prev => ({ ...prev, notes: item }));
                                        setActiveStoreEditSug(false);
                                      }}
                                      style={{ fontSize: '0.72rem', padding: '6px 8px', cursor: 'pointer' }}
                                    >
                                      {item}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>

                            {/* Purchase Date */}
                            <div className="mgr-edit-field">
                              <label className="stock-builder-lbl">Purchase Date</label>
                              <input
                                type="date"
                                className="form-input"
                                style={{ width: '100%' }}
                                value={editFormData.purchased_date}
                                onFocus={() => setActiveStoreEditSug(false)}
                                onChange={e => setEditFormData({ ...editFormData, purchased_date: e.target.value })}
                              />
                            </div>

                            {/* Calculated dynamic display */}
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 2, paddingInline: 2, marginTop: 4 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span>Price per packunit (Unit Price):</span>
                                <span style={{ fontWeight: 700, color: 'var(--accent)' }}>
                                  ₹{editUnitPrice.toFixed(2)} / part
                                </span>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span>Total Remaining Value (Item Price * Available Parts):</span>
                                <span style={{ fontWeight: 700, color: 'var(--green)' }}>
                                  ₹{editRemainingTotalValue.toFixed(2)}
                                </span>
                              </div>
                            </div>

                            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                              <button className="stock-btn-action consume" onClick={() => handleSaveEditBatch(batch.id)}>Save</button>
                              <button className="stock-btn-action" onClick={() => setEditingBatchId(null)}>Cancel</button>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div key={batch.id} className="stock-batch-row">
                          <div className="stock-batch-meta">
                            <span style={{ fontWeight: 700 }}>
                              📅 {batch.purchased_date ? new Date(batch.purchased_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Unknown Date'}
                              {batch.notes && ` @ ${batch.notes}`}
                            </span>
                            <span style={{ fontWeight: 800, color: 'var(--green)' }}>
                              {formatFraction(batch.qty)} {batch.unit || 'pcs'}
                              {batch.sub_unit && (() => {
                                const remPacks = (batch.original_qty > 0) ? (batch.qty / (batch.original_qty / (batch.pack_qty || 1))) : batch.qty;
                                return ` (${formatFraction(remPacks * batch.sub_qty)} ${batch.sub_unit})`;
                              })()}
                            </span>
                          </div>
                          <div className="stock-batch-meta" style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                            <span>Price: ₹{Number(parseFloat(batch.discounted_price || batch.price || 0).toFixed(1))} / {batch.unit || 'pc'}</span>
                            <span>Batch Value: {formatINR(batchCost)}</span>
                          </div>

                          {isConsuming ? (
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
                                Use Item: {group.name} ({batch.purchased_date ? new Date(batch.purchased_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : 'Unknown'})
                              </div>
                              
                              {/* Usage Type toggles */}
                              <div style={{ display: 'flex', gap: 6, width: '100%', marginBottom: 4 }}>
                                <button
                                  type="button"
                                  className="stock-btn-action"
                                  style={{
                                    flex: 1,
                                    background: usageType === 'consume' ? 'var(--blue-bg)' : 'var(--bg-card2)',
                                    color: usageType === 'consume' ? 'var(--blue)' : 'var(--text-primary)',
                                    borderColor: usageType === 'consume' ? 'rgba(77, 159, 255, 0.2)' : 'var(--border)'
                                  }}
                                  onClick={() => setUsageType('consume')}
                                >
                                  🍽️ Consume
                                </button>
                                <button
                                  type="button"
                                  className="stock-btn-action"
                                  style={{
                                    flex: 1,
                                    background: usageType === 'lend' ? 'rgba(255, 179, 0, 0.15)' : 'var(--bg-card2)',
                                    color: usageType === 'lend' ? 'var(--gold)' : 'var(--text-primary)',
                                    borderColor: usageType === 'lend' ? 'rgba(255, 179, 0, 0.2)' : 'var(--border)'
                                  }}
                                  onClick={() => setUsageType('lend')}
                                >
                                  🤝 Lend
                                </button>
                                <button
                                  type="button"
                                  className="stock-btn-action"
                                  style={{
                                    flex: 1,
                                    background: usageType === 'instalment' ? 'rgba(255, 179, 0, 0.15)' : 'var(--bg-card2)',
                                    color: usageType === 'instalment' ? 'var(--gold)' : 'var(--text-primary)',
                                    borderColor: usageType === 'instalment' ? 'rgba(255, 179, 0, 0.2)' : 'var(--border)'
                                  }}
                                  onClick={() => setUsageType('instalment')}
                                >
                                  📋 Instalment
                                </button>
                              </div>

                              {batch.sub_unit && parseFloat(batch.sub_qty) > 1 && (
                                <div style={{ display: 'flex', gap: 6, width: '100%', marginBottom: 4 }}>
                                  <button
                                    type="button"
                                    className="stock-btn-action"
                                    style={{
                                      flex: 1,
                                      background: consumeUnitMode === 'pack' ? 'var(--blue-bg)' : 'var(--bg-card2)',
                                      color: consumeUnitMode === 'pack' ? 'var(--blue)' : 'var(--text-primary)'
                                    }}
                                    onClick={() => {
                                      setConsumeUnitMode('pack');
                                      setConsumeQty(String(Math.min(1, batch.qty)));
                                    }}
                                  >
                                    Use {batch.unit || 'pcs'}
                                  </button>
                                  <button
                                    type="button"
                                    className="stock-btn-action"
                                    style={{
                                      flex: 1,
                                      background: consumeUnitMode === 'sub' ? 'var(--blue-bg)' : 'var(--bg-card2)',
                                      color: consumeUnitMode === 'sub' ? 'var(--blue)' : 'var(--text-primary)'
                                    }}
                                    onClick={() => {
                                      setConsumeUnitMode('sub');
                                      setConsumeQty(String(batch.sub_qty));
                                    }}
                                  >
                                    Use {batch.sub_unit}
                                  </button>
                                </div>
                              )}

                              <div className="mgr-edit-field">
                                <label className="stock-builder-lbl">Qty to Use</label>
                                <input
                                  type="number"
                                  step="any"
                                  className={`form-input ${consumeError ? 'err' : ''}`}
                                  value={consumeQty}
                                  onFocus={e => e.target.select()}
                                  onChange={e => {
                                    setConsumeQty(e.target.value);
                                    setConsumeError('');
                                  }}
                                />
                              </div>

                              {usageType === 'lend' ? (
                                <div className="mgr-edit-field" style={{ position: 'relative' }}>
                                  <label className="stock-builder-lbl">Lend to (Person)</label>
                                  <input
                                    type="text"
                                    className="form-input"
                                    placeholder="Person name..."
                                    value={personName}
                                    onClick={e => { e.stopPropagation(); setActiveLendSug(true); }}
                                    onFocus={() => setActiveLendSug(true)}
                                    onChange={e => {
                                      setPersonName(e.target.value);
                                      setActiveLendSug(true);
                                    }}
                                  />
                                  {activeLendSug && debtPeople.filter(p => p.toLowerCase().includes(personName.toLowerCase())).length > 0 && (
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
                                <>
                                  <div className="stock-row-grid-2">
                                    <div className="mgr-edit-field">
                                      <label className="stock-builder-lbl">Category</label>
                                      <select
                                        className="form-input"
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
                                        value={consumeSubcategory}
                                        onChange={e => setConsumeSubcategory(e.target.value)}
                                      >
                                        {subcategoriesList.map(s => <option key={s} value={s}>{s}</option>)}
                                      </select>
                                    </div>
                                  </div>
                                  {usageType === 'instalment' && (
                                    <div className="mgr-edit-field">
                                      <label className="stock-builder-lbl">Instalment Months</label>
                                      <input
                                        type="number"
                                        className="form-input"
                                        value={instalmentMonths}
                                        onFocus={e => e.target.select()}
                                        onChange={e => setInstalmentMonths(e.target.value)}
                                      />
                                    </div>
                                  )}
                                </>
                              )}

                              <div className="stock-row-grid-2">
                                <div className="mgr-edit-field">
                                  <label className="stock-builder-lbl">Date</label>
                                  <input
                                    type="date"
                                    className="form-input"
                                    value={consumeDate}
                                    onChange={e => setConsumeDate(e.target.value)}
                                  />
                                </div>
                                <div className="mgr-edit-field">
                                  <label className="stock-builder-lbl">Time</label>
                                  <input
                                    type="time"
                                    className="form-input"
                                    value={consumeTime}
                                    onChange={e => setConsumeTime(e.target.value)}
                                  />
                                </div>
                              </div>

                              {consumeError && (
                                <div className="field-error" style={{ width: '100%', marginTop: 4 }}>
                                  ⚠️ {consumeError}
                                </div>
                              )}

                              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                                <button className="stock-btn-action consume" onClick={() => handleConsume(batch)}>Save</button>
                                <button className="stock-btn-action" onClick={() => { setConsumingItemId(null); setConsumeError(''); }}>Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 2 }}>
                              {batch.qty > 0 && (
                                <button
                                  className="stock-btn-action consume"
                                  onClick={() => {
                                    setConsumingItemId(batch.id);
                                    setConsumeUnitMode('pack');
                                    setUsageType('consume');
                                    setConsumeQty(String(Math.min(1, batch.qty)));
                                    
                                    const now = new Date();
                                    const yyyy = now.getFullYear();
                                    const mm = String(now.getMonth() + 1).padStart(2, '0');
                                    const dd = String(now.getDate()).padStart(2, '0');
                                    const hh = String(now.getHours()).padStart(2, '0');
                                    const min = String(now.getMinutes()).padStart(2, '0');
                                    setConsumeDate(`${yyyy}-${mm}-${dd}`);
                                    setConsumeTime(`${hh}:${min}`);
                                    setInstalmentMonths('3');
                                  }}
                                >
                                  🍽️ Use
                                </button>
                              )}
                              <button className="stock-btn-action edit" onClick={() => handleStartEditBatch(batch)}>✏️ Edit</button>
                              <button className="stock-btn-action delete" onClick={() => handleDeleteItem(batch.id)}>✕ Delete</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {groupedItems.length === 0 && (
            <div className="empty-state" style={{ padding: '40px 10px' }}>
              <div className="empty-icon">🥫</div>
              <div className="empty-title">No stock items found</div>
              <div className="empty-desc">Click "➕ Purchase" above to add new stock items!</div>
            </div>
          )}
        </div>
      </div>

      {/* Stock Purchase Modal Form */}
      {showPurchaseModal && (
        <div className="stock-purchase-modal" onClick={e => e.stopPropagation()}>
          <div className="stock-purchase-content">
            <div className="page-hdr" style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="page-hdr-title">Log Stock Purchase</div>
              <button
                onClick={() => setShowPurchaseModal(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '1.2rem', cursor: 'pointer', marginLeft: 'auto', padding: '0 8px' }}
              >
                ✕
              </button>
            </div>

            <div className="stock-purchase-body">
              {/* Date, Time, Note Row */}
              <div className="stock-row-grid-3">
                <div className="mgr-edit-field">
                  <label className="stock-builder-lbl">Date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={purchaseDate}
                    onFocus={() => {
                      setShowAccountPicker(false);
                      setActiveItemSugIdx(null);
                      setActiveStoreSugIdx(null);
                    }}
                    onChange={e => setPurchaseDate(e.target.value)}
                  />
                </div>
                <div className="mgr-edit-field">
                  <label className="stock-builder-lbl">Time</label>
                  <input
                    type="time"
                    className="form-input"
                    value={purchaseTime}
                    onFocus={() => {
                      setShowAccountPicker(false);
                      setActiveItemSugIdx(null);
                      setActiveStoreSugIdx(null);
                    }}
                    onChange={e => setPurchaseTime(e.target.value)}
                  />
                </div>
                <div className="mgr-edit-field">
                  <label className="stock-builder-lbl">Note</label>
                  <input
                    type="text"
                    className="form-input"
                    value={purchaseNote}
                    onFocus={() => {
                      setShowAccountPicker(false);
                      setActiveItemSugIdx(null);
                      setActiveStoreSugIdx(null);
                    }}
                    onChange={e => setPurchaseNote(e.target.value)}
                  />
                </div>
              </div>

              {/* Account selection trigger & overlay */}
              <div className="form-group" style={{ position: 'relative' }}>
                <label className="stock-builder-lbl">Paid From</label>
                <button
                  type="button"
                  className="picker-trigger"
                  style={{ textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowAccountPicker(!showAccountPicker);
                    setActiveItemSugIdx(null);
                    setActiveStoreSugIdx(null);
                  }}
                >
                  <span className="picker-trigger-value" style={{ fontWeight: 700 }}>
                    {purchaseFrom || 'Select Account'}
                  </span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" style={{ transform: showAccountPicker ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s', opacity: 0.5 }}><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {errors.purchaseFrom && <span className="field-error">{errors.purchaseFrom}</span>}

                {showAccountPicker && (
                  <div className="account-dropdown-overlay" style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: '100%',
                    zIndex: 100,
                    marginTop: 4,
                    background: 'var(--bg-card)',
                    border: '1.5px solid var(--border)',
                    borderRadius: '14px',
                    padding: '8px',
                    boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6
                  }}>
                    {(accounts || []).map(a => {
                      const name = typeof a === 'object' ? a.name : a;
                      const isSelected = purchaseFrom === name;
                      return (
                        <button
                          key={name}
                          type="button"
                          onClick={() => {
                            setPurchaseFrom(name);
                            setShowAccountPicker(false);
                            if (errors.purchaseFrom) {
                              setErrors(prev => {
                                const c = { ...prev };
                                delete c.purchaseFrom;
                                return c;
                              });
                            }
                          }}
                          style={{
                            padding: '6px 12px',
                            borderRadius: '10px',
                            fontSize: '0.72rem',
                            fontWeight: 700,
                            border: `1.5px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                            background: isSelected ? 'rgba(0, 229, 160, 0.1)' : 'var(--bg-card2)',
                            color: isSelected ? 'var(--accent)' : 'var(--text-primary)',
                            cursor: 'pointer'
                          }}
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Items list */}
              <div>
                <span style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--text-secondary)' }}>Items List</span>

                {purchaseItems.map((item, idx) => {
                  const itemErr = errors[`item_${idx}`] || {};

                  const finalBatchPrice = calculateDiscountedPrice(item);
                  const totalParts = parseFloat(item.original_qty) || 1;
                  const unitPrice = totalParts > 0 ? (finalBatchPrice / totalParts) : 0;
                  const availParts = parseFloat(item.qty) || 0;
                  const remainingTotalValue = unitPrice * availParts;

                  return (
                    <div key={idx} className="stock-item-row-builder" style={{ marginTop: 6, borderBottom: '1px dashed var(--border)', paddingBottom: '10px' }}>
                      {purchaseItems.length > 1 && (
                        <button
                          type="button"
                          className="stock-row-delete-btn"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleRemovePurchaseItem(idx);
                          }}
                          title="Remove item"
                        >
                          ✕
                        </button>
                      )}

                      <div className="mgr-edit-field" style={{ position: 'relative' }}>
                        <label className="stock-builder-lbl">Item Name</label>
                        <input
                          type="text"
                          className="form-input"
                          placeholder="e.g. Toothpaste, Soap, Detergent"
                          value={item.name}
                          onClick={e => {
                            e.stopPropagation();
                            setShowAccountPicker(false);
                            setActiveItemSugIdx(idx);
                            setActiveStoreSugIdx(null);
                          }}
                          onFocus={() => {
                            setShowAccountPicker(false);
                            setActiveItemSugIdx(idx);
                            setActiveStoreSugIdx(null);
                          }}
                          onChange={e => {
                            handlePurchaseItemChange(idx, 'name', e.target.value);
                            setActiveItemSugIdx(idx);
                          }}
                        />
                        {activeItemSugIdx === idx && itemSuggestions.filter(s => s.toLowerCase().includes(item.name.toLowerCase())).length > 0 && (
                          <div className="note-sug-list" style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 100, maxHeight: 150, overflowY: 'auto' }}>
                            {itemSuggestions.filter(s => s.toLowerCase().includes(item.name.toLowerCase())).map(s => (
                              <div
                                key={s}
                                className="note-sug-item"
                                onMouseDown={() => {
                                  handlePurchaseItemChange(idx, 'name', s);
                                  setActiveItemSugIdx(null);
                                }}
                                style={{ fontSize: '0.78rem', padding: '6px 10px', cursor: 'pointer' }}
                              >
                                {s}
                              </div>
                            ))}
                          </div>
                        )}
                        {itemErr.name && <span className="field-error">{itemErr.name}</span>}
                      </div>

                      {/* Pack Size & Unit & Qty */}
                      <div className="stock-row-grid-3">
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Pack Size</label>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            placeholder="e.g. 200"
                            value={item.sub_qty}
                            onFocus={(e) => {
                              setShowAccountPicker(false);
                              setActiveItemSugIdx(null);
                              setActiveStoreSugIdx(null);
                              e.target.select();
                            }}
                            onChange={e => handlePurchaseItemChange(idx, 'sub_qty', e.target.value)}
                          />
                          {itemErr.sub_qty && <span className="field-error">{itemErr.sub_qty}</span>}
                        </div>
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Pack Unit</label>
                          <select
                            className="form-input"
                            value={normalizeUnit(item.sub_unit)}
                            onFocus={() => {
                              setShowAccountPicker(false);
                              setActiveItemSugIdx(null);
                              setActiveStoreSugIdx(null);
                            }}
                            onChange={e => handlePurchaseItemChange(idx, 'sub_unit', e.target.value)}
                          >
                            <option value="g">g</option>
                            <option value="kg">kg</option>
                            <option value="ml">ml</option>
                            <option value="litre">litre</option>
                            <option value="pcs">pcs</option>
                            <option value="box">box</option>
                            <option value="packet">packet</option>
                          </select>
                          {itemErr.sub_unit && <span className="field-error">{itemErr.sub_unit}</span>}
                        </div>
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Qty (Packs)</label>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            placeholder="1"
                            value={item.pack_qty}
                            onFocus={(e) => {
                              setShowAccountPicker(false);
                              setActiveItemSugIdx(null);
                              setActiveStoreSugIdx(null);
                              e.target.select();
                            }}
                            onChange={e => handlePurchaseItemChange(idx, 'pack_qty', e.target.value)}
                          />
                          {itemErr.pack_qty && <span className="field-error">{itemErr.pack_qty}</span>}
                        </div>
                      </div>

                      {/* Parts & Available Parts */}
                      <div className="stock-row-grid-2">
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Parts (n)</label>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            placeholder="e.g. 4"
                            value={item.original_qty}
                            onFocus={(e) => {
                              setShowAccountPicker(false);
                              setActiveItemSugIdx(null);
                              setActiveStoreSugIdx(null);
                              e.target.select();
                            }}
                            onChange={e => {
                              const val = e.target.value;
                              handlePurchaseItemChange(idx, 'original_qty', val);
                              if (item.qty === '' || item.qty === item.original_qty) {
                                handlePurchaseItemChange(idx, 'qty', val);
                              }
                            }}
                          />
                          {itemErr.original_qty && <span className="field-error">{itemErr.original_qty}</span>}
                        </div>
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Available Parts (n)</label>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            placeholder="e.g. 4"
                            value={item.qty}
                            onFocus={(e) => {
                              setShowAccountPicker(false);
                              setActiveItemSugIdx(null);
                              setActiveStoreSugIdx(null);
                              e.target.select();
                            }}
                            onChange={e => handlePurchaseItemChange(idx, 'qty', e.target.value)}
                          />
                          {itemErr.qty && <span className="field-error">{itemErr.qty}</span>}
                        </div>
                      </div>

                      {/* Original Price & Discount */}
                      <div className="stock-row-grid-2">
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Original Price (₹)</label>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            value={item.price}
                            onFocus={(e) => {
                              setShowAccountPicker(false);
                              setActiveItemSugIdx(null);
                              setActiveStoreSugIdx(null);
                              e.target.select();
                            }}
                            onChange={e => handlePurchaseItemChange(idx, 'price', e.target.value)}
                          />
                          {itemErr.price && <span className="field-error">{itemErr.price}</span>}
                        </div>
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Discount</label>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              type="button"
                              onClick={() => handlePurchaseItemChange(idx, 'discountType', 'percentage')}
                              style={{
                                padding: '4px 8px',
                                fontSize: '0.7rem',
                                fontWeight: 800,
                                borderRadius: '6px',
                                border: '1px solid var(--border)',
                                background: item.discountType === 'percentage' ? 'var(--green)' : 'var(--bg-card2)',
                                color: item.discountType === 'percentage' ? '#0a0f1e' : 'var(--text-primary)',
                                cursor: 'pointer'
                              }}
                            >
                              %
                            </button>
                            <button
                              type="button"
                              onClick={() => handlePurchaseItemChange(idx, 'discountType', 'value')}
                              style={{
                                padding: '4px 8px',
                                fontSize: '0.7rem',
                                fontWeight: 800,
                                borderRadius: '6px',
                                border: '1px solid var(--border)',
                                background: item.discountType === 'value' ? 'var(--green)' : 'var(--bg-card2)',
                                color: item.discountType === 'value' ? '#0a0f1e' : 'var(--text-primary)',
                                cursor: 'pointer'
                              }}
                            >
                              ₹
                            </button>
                            <input
                              type="number"
                              step="any"
                              className="form-input"
                              style={{ flex: 1 }}
                              placeholder={item.discountType === 'percentage' ? 'Disc. %' : 'Value after disc.'}
                              value={item.discountValue}
                              onFocus={e => {
                                setShowAccountPicker(false);
                                setActiveItemSugIdx(null);
                                setActiveStoreSugIdx(null);
                                e.target.select();
                              }}
                              onChange={e => handlePurchaseItemChange(idx, 'discountValue', e.target.value)}
                            />
                          </div>
                          {itemErr.discountValue && <span className="field-error">{itemErr.discountValue}</span>}
                        </div>
                      </div>

                      {/* Store Name & suggestions */}
                      <div className="mgr-edit-field" style={{ position: 'relative' }}>
                        <label className="stock-builder-lbl">Store Name</label>
                        <input
                          type="text"
                          className="form-input"
                          placeholder="e.g. Amazon, DMart"
                          value={item.notes}
                          onClick={e => {
                            e.stopPropagation();
                            setShowAccountPicker(false);
                            setActiveItemSugIdx(null);
                            setActiveStoreSugIdx(idx);
                          }}
                          onFocus={() => {
                            setShowAccountPicker(false);
                            setActiveItemSugIdx(null);
                            setActiveStoreSugIdx(idx);
                          }}
                          onChange={e => {
                            handlePurchaseItemChange(idx, 'notes', e.target.value);
                            setActiveStoreSugIdx(idx);
                          }}
                        />
                        {activeStoreSugIdx === idx && storeSuggestions.filter(s => s.toLowerCase().includes(item.notes.toLowerCase())).length > 0 && (
                          <div className="note-sug-list" style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 100, maxHeight: 150, overflowY: 'auto' }}>
                            {storeSuggestions.filter(s => s.toLowerCase().includes(item.notes.toLowerCase())).map(s => (
                              <div
                                key={s}
                                className="note-sug-item"
                                onMouseDown={() => {
                                  handlePurchaseItemChange(idx, 'notes', s);
                                  setActiveStoreSugIdx(null);
                                }}
                                style={{ fontSize: '0.78rem', padding: '6px 10px', cursor: 'pointer' }}
                              >
                                {s}
                              </div>
                            ))}
                          </div>
                        )}
                        {itemErr.notes && <span className="field-error">{itemErr.notes}</span>}
                      </div>

                      {/* Calculated price as same before (non editable) */}
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 2, paddingInline: 2, marginTop: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>Price per packunit (Unit Price):</span>
                          <span style={{ fontWeight: 700, color: 'var(--accent)' }}>
                            ₹{unitPrice.toFixed(2)} / part
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>Total Remaining Value (Item Price * Available Parts):</span>
                          <span style={{ fontWeight: 700, color: 'var(--green)' }}>
                            ₹{remainingTotalValue.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Add Item Button below the last item list */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                  <button
                    className="stock-btn-action"
                    onClick={handleAddNewPurchaseItem}
                    style={{ padding: '6px 12px', fontSize: '0.72rem' }}
                  >
                    ➕ Add Item
                  </button>
                </div>
              </div>

              {/* Grand Total display */}
              <div className="grand-total-section">
                <span style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--text-secondary)' }}>Grand Total:</span>
                <div style={{ textAlign: 'right' }}>
                  {totalBeforeDiscount > totalPurchaseSum && (
                    <div style={{ fontSize: '0.72rem', textDecoration: 'line-through', color: 'var(--text-muted)', marginRight: 4, fontWeight: 700 }}>
                      {formatINR(totalBeforeDiscount)}
                    </div>
                  )}
                  <div style={{ fontSize: '1.25rem', fontWeight: 900, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
                    {formatINR(totalPurchaseSum)}
                  </div>
                </div>
              </div>

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <button
                  className="btn btn-secondary btn-full"
                  onClick={() => setShowPurchaseModal(false)}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary btn-full"
                  onClick={handleSavePurchase}
                >
                  Save Stock
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {popup && (
        <div className="stock-modal-backdrop" style={{ zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="stock-modal-card animate-pop" style={{ width: '90%', maxWidth: 360, padding: 20, borderRadius: 16, border: '1px solid var(--border-color)', background: 'var(--card-bg)' }}>
            <h3 style={{ marginTop: 0, fontSize: '1rem', fontWeight: 800 }}>
              {popup.type === 'confirm' ? 'Confirm Action' : 'Notification'}
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5, margin: '12px 0 20px 0' }}>
              {popup.message}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              {popup.type === 'confirm' && (
                <button
                  className="btn btn-sm btn-secondary"
                  style={{ borderRadius: 8, padding: '6px 14px', fontSize: '0.75rem' }}
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
                style={{ borderRadius: 8, padding: '6px 14px', fontSize: '0.75rem' }}
                onClick={() => {
                  if (popup.onConfirm) popup.onConfirm();
                  setPopup(null);
                }}
              >
                {popup.type === 'confirm' ? 'Proceed' : 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  </>
  );
}
