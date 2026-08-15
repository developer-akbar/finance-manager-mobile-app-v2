import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR } from '../../utils/format.js';
import {
  getInventoryItems,
  addInventoryPurchase,
  consumeInventoryItem,
  updateInventoryItem,
  deleteInventoryItem
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
    { dec: 1/3, frac: '1/3' },
    { dec: 2/3, frac: '2/3' },
    { dec: 1/8, frac: '1/8' },
    { dec: 3/8, frac: '3/8' },
    { dec: 5/8, frac: '5/8' },
    { dec: 7/8, frac: '7/8' },
    { dec: 0.2, frac: '1/5' },
    { dec: 0.4, frac: '2/5' },
    { dec: 0.6, frac: '3/5' },
    { dec: 0.8, frac: '4/5' },
    { dec: 1/6, frac: '1/6' },
    { dec: 5/6, frac: '5/6' },
  ];

  for (const item of fractions) {
    if (Math.abs(decimalPart - item.dec) < epsilon) {
      return integerPart > 0 ? `${integerPart} ${item.frac}` : item.frac;
    }
  }

  return String(parseFloat(val.toFixed(3)));
};

export default function StockManager({ onBack, backInterceptRef }) {
  const { state, load } = useApp();
  const { accounts, categories, transactions } = state;

  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('in_stock'); // 'in_stock', 'out_of_stock', 'all'
  const [search, setSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState({});

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
  const [consumeUnitMode, setConsumeUnitMode] = useState('pack'); // 'pack' or 'sub'
  const [consumeCategory, setConsumeCategory] = useState('To Home');
  const [consumeSubcategory, setConsumeSubcategory] = useState('Groceries');
  const [usageType, setUsageType] = useState('consume'); // 'consume' or 'lend'
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
    { name: '', qty: '', unit: 'pcs', price: '', discountType: 'percentage', discountValue: '', notes: '', sub_qty: '1', sub_unit: '' }
  ]);
  const [errors, setErrors] = useState({});

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
      backInterceptRef.current = () => setConsumingItemId(null);
    } else if (editingBatchId) {
      backInterceptRef.current = () => setEditingBatchId(null);
    } else {
      backInterceptRef.current = onBack;
    }
    return () => {
      if (backInterceptRef) backInterceptRef.current = onBack;
    };
  }, [showPurchaseModal, consumingItemId, editingBatchId, onBack, backInterceptRef]);

  // Compute statistics
  const stats = useMemo(() => {
    let availableValue = 0;
    let totalSaved = 0;

    items.forEach(item => {
      const qty = parseFloat(item.qty) || 0;
      const price = parseFloat(item.price) || 0;
      const discPrice = parseFloat(item.discounted_price) || price;

      availableValue += qty * discPrice;
      totalSaved += qty * Math.max(0, price - discPrice);
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
          batches: []
        };
      }
      const g = groups[key];
      const qty = parseFloat(item.qty) || 0;
      const price = parseFloat(item.discounted_price) || parseFloat(item.price) || 0;
      g.totalQty += qty;
      g.availableValue += qty * price;
      g.batches.push(item);
    });

    return Object.values(groups)
      .map(g => {
        g.batches.sort((a, b) => (b.purchased_date || '').localeCompare(a.purchased_date || ''));
        return g;
      })
      .filter(g => {
        const matchesSearch = g.name.toLowerCase().includes(search.toLowerCase()) ||
          g.batches.some(b => (b.notes || '').toLowerCase().includes(search.toLowerCase()));
        
        const matchesFilter =
          filter === 'all' ? true :
          filter === 'in_stock' ? g.totalQty > 0 :
          g.totalQty === 0;

        return matchesSearch && matchesFilter;
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
      await consumeInventoryItem(item.id, qty, consumeDate, isSubMode, consumeCategory, consumeSubcategory, usageType, personName);
      setConsumingItemId(null);
      setConsumeQty('');
      setPersonName('');
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
        qty: '',
        unit: 'pcs',
        price: '',
        discountType: firstItem.discountType || 'percentage',
        discountValue: firstItem.discountValue || '',
        notes: firstItem.notes || '',
        sub_qty: '1',
        sub_unit: ''
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
        itemErr.name = 'Item name is required.';
      }
      const qty = parseFloat(item.qty);
      if (isNaN(qty) || qty <= 0) {
        itemErr.qty = 'Qty must be greater than 0.';
      }
      
      if (Object.keys(itemErr).length > 0) {
        newErrors[`item_${idx}`] = itemErr;
      } else {
        const price = parseFloat(item.price) || 0;
        const discounted_price = calculateDiscountedPrice(item);
        validItems.push({
          name: item.name.trim(),
          qty: qty,
          unit: item.unit,
          price: price,
          discounted_price: discounted_price,
          notes: item.notes.trim(),
          sub_qty: parseFloat(item.sub_qty) || 1,
          sub_unit: (item.sub_unit || '').trim()
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
      setPurchaseItems([{ name: '', qty: '', unit: 'pcs', price: '', discountType: 'percentage', discountValue: '', notes: '', sub_qty: '1', sub_unit: '' }]);
      setPurchaseNote('in stock');
      setPurchaseTime(new Date().toLocaleTimeString('en-IN', { hour12: false }).slice(0, 5));
      await fetchItems();
      await load();
    } catch (err) {
      console.error(err);
      alert('Failed to save purchase.');
    }
  };

  const handleStartEditBatch = (batch) => {
    setEditingBatchId(batch.id);
    setEditFormData({
      name: batch.name,
      qty: String(batch.qty),
      unit: batch.unit || 'pcs',
      price: String(batch.price || 0),
      discounted_price: String(batch.discounted_price || batch.price || 0),
      purchased_date: batch.purchased_date || '',
      notes: batch.notes || '',
      sub_qty: String(batch.sub_qty || 1),
      sub_unit: batch.sub_unit || ''
    });
  };

  const handleSaveEditBatch = async (batchId) => {
    try {
      await updateInventoryItem(batchId, {
        name: editFormData.name,
        qty: parseFloat(editFormData.qty) || 0,
        unit: editFormData.unit,
        price: parseFloat(editFormData.price) || 0,
        discounted_price: parseFloat(editFormData.discounted_price) || parseFloat(editFormData.price) || 0,
        purchased_date: editFormData.purchased_date,
        notes: editFormData.notes,
        sub_qty: parseFloat(editFormData.sub_qty) || 1,
        sub_unit: editFormData.sub_unit
      });
      setEditingBatchId(null);
      await fetchItems();
    } catch (err) {
      console.error(err);
      alert('Failed to update batch details.');
    }
  };

  const handleDeleteItem = async (id) => {
    if (!window.confirm('Delete this stock batch?')) return;
    try {
      await deleteInventoryItem(id);
      await fetchItems();
    } catch (err) {
      console.error(err);
      alert('Failed to delete item.');
    }
  };

  const toggleGroup = (key) => {
    setExpandedGroups(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const totalPurchaseSum = useMemo(() => {
    return purchaseItems.reduce((sum, item) => {
      const qty = parseFloat(item.qty) || 0;
      const finalPrice = calculateDiscountedPrice(item);
      return sum + (qty * finalPrice);
    }, 0);
  }, [purchaseItems]);

  const totalBeforeDiscount = useMemo(() => {
    return purchaseItems.reduce((sum, item) => {
      const qty = parseFloat(item.qty) || 0;
      const price = parseFloat(item.price) || 0;
      return sum + (qty * price);
    }, 0);
  }, [purchaseItems]);

  return (
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
          className="btn btn-sm btn-primary"
          style={{ padding: '6px 12px', fontSize: '0.75rem', borderRadius: 8 }}
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
            const totalSubVal = group.totalQty * group.sub_qty;
            const avgPrice = group.totalQty > 0 ? (group.availableValue / group.totalQty) : 0;

            return (
              <div key={group.key} className="stock-item-card" onClick={() => toggleGroup(group.key)}>
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
                          (total: {formatFraction(totalSubVal)} {group.sub_unit})
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
                        return (
                          <div key={batch.id} className="stock-batch-row" style={{ gap: 8, padding: 10 }}>
                            <div className="stock-builder-lbl" style={{ color: 'var(--accent)' }}>Edit Batch Details</div>
                            <div className="stock-row-grid-2">
                              <div className="mgr-edit-field">
                                <label className="stock-builder-lbl">Qty</label>
                                <input
                                  type="number"
                                  className="stock-consume-input"
                                  style={{ width: '100%' }}
                                  value={editFormData.qty}
                                  onChange={e => setEditFormData({ ...editFormData, qty: e.target.value })}
                                />
                              </div>
                              <div className="mgr-edit-field">
                                <label className="stock-builder-lbl">Unit</label>
                                <input
                                  type="text"
                                  className="stock-consume-input"
                                  style={{ width: '100%' }}
                                  value={editFormData.unit}
                                  onChange={e => setEditFormData({ ...editFormData, unit: e.target.value })}
                                />
                              </div>
                            </div>
                            <div className="stock-row-grid-2">
                              <div className="mgr-edit-field">
                                <label className="stock-builder-lbl">Original Price</label>
                                <input
                                  type="number"
                                  className="stock-consume-input"
                                  style={{ width: '100%' }}
                                  value={editFormData.price}
                                  onChange={e => setEditFormData({ ...editFormData, price: e.target.value })}
                                />
                              </div>
                              <div className="mgr-edit-field">
                                <label className="stock-builder-lbl">Discounted Price</label>
                                <input
                                  type="number"
                                  className="stock-consume-input"
                                  style={{ width: '100%' }}
                                  value={editFormData.discounted_price}
                                  onChange={e => setEditFormData({ ...editFormData, discounted_price: e.target.value })}
                                />
                              </div>
                            </div>
                            <div className="stock-row-grid-2">
                              <div className="mgr-edit-field" style={{ position: 'relative' }}>
                                <label className="stock-builder-lbl">Store Name</label>
                                <input
                                  type="text"
                                  className="stock-consume-input"
                                  style={{ width: '100%' }}
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
                              <div className="mgr-edit-field">
                                <label className="stock-builder-lbl">Purchase Date</label>
                                <input
                                  type="date"
                                  className="stock-consume-input"
                                  style={{ width: '100%' }}
                                  value={editFormData.purchased_date}
                                  onChange={e => setEditFormData({ ...editFormData, purchased_date: e.target.value })}
                                />
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
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
                              📅 {batch.purchased_date ? new Date(batch.purchased_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : 'Unknown Date'}
                              {batch.notes && ` @ ${batch.notes}`}
                            </span>
                             <span style={{ fontWeight: 800, color: 'var(--green)' }}>
                               {formatFraction(batch.qty)} {batch.unit || 'pcs'}
                               {batch.sub_unit && ` (${formatFraction(batch.qty * batch.sub_qty)} ${batch.sub_unit})`}
                             </span>
                          </div>
                          <div className="stock-batch-meta" style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                            <span>Price: ₹{batch.discounted_price || batch.price || 0} / {batch.unit || 'pc'}</span>
                            <span>Batch Value: {formatINR(batchCost)}</span>
                          </div>

                          {isConsuming ? (
                            <div className="stock-consume-inline" style={{ gap: 6 }}>
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
                                  🤝 Lend Item
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

                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, width: '100%', alignItems: 'center', position: 'relative' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                  <span style={{ fontSize: '0.65rem', fontWeight: 700 }}>Qty:</span>
                                  <input
                                    type="number"
                                    step="any"
                                    className={`stock-consume-input ${consumeError ? 'err' : ''}`}
                                    style={{ width: 65 }}
                                    value={consumeQty}
                                    onChange={e => {
                                      setConsumeQty(e.target.value);
                                      setConsumeError('');
                                    }}
                                  />
                                </div>

                                {usageType === 'lend' ? (
                                  <div style={{ position: 'relative', flex: 1, minWidth: 120 }}>
                                    <input
                                      type="text"
                                      className="stock-consume-input"
                                      style={{ width: '100%' }}
                                      placeholder="Lend to (Person)..."
                                      value={personName}
                                      onClick={e => { e.stopPropagation(); setActiveLendSug(true); }}
                                      onFocus={() => setActiveLendSug(true)}
                                      onChange={e => {
                                        setPersonName(e.target.value);
                                        setActiveLendSug(true);
                                      }}
                                    />
                                    {activeLendSug && debtPeople.filter(p => p.toLowerCase().includes(personName.toLowerCase())).length > 0 && (
                                      <div className="note-sug-list" style={{ position: 'absolute', left: 0, right: 0, bottom: '100%', mb: 4, zIndex: 100, maxHeight: 100, overflowY: 'auto' }}>
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
                                    <select
                                      className="stock-consume-input"
                                      style={{ width: 95 }}
                                      value={consumeCategory}
                                      onChange={e => {
                                        setConsumeCategory(e.target.value);
                                        const firstSub = categories?.[e.target.value]?.subcategories?.[0] || '';
                                        setConsumeSubcategory(firstSub);
                                      }}
                                    >
                                      {categoriesList.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                    <select
                                      className="stock-consume-input"
                                      style={{ width: 95 }}
                                      value={consumeSubcategory}
                                      onChange={e => setConsumeSubcategory(e.target.value)}
                                    >
                                      {subcategoriesList.map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                  </>
                                )}

                                <input
                                  type="date"
                                  className="stock-consume-input"
                                  style={{ width: 100 }}
                                  value={consumeDate}
                                  onChange={e => setConsumeDate(e.target.value)}
                                />

                                {consumeError && (
                                  <div className="field-error" style={{ width: '100%', marginTop: 4 }}>
                                    ⚠️ {consumeError}
                                  </div>
                                )}

                                <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', marginTop: 4 }}>
                                  <button className="stock-btn-action consume" onClick={() => handleConsume(batch)}>Save</button>
                                  <button className="stock-btn-action" onClick={() => { setConsumingItemId(null); setConsumeError(''); }}>Cancel</button>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 2 }}>
                              <button
                                className="stock-btn-action consume"
                                disabled={batch.qty <= 0}
                                onClick={() => {
                                  setConsumingItemId(batch.id);
                                  setConsumeUnitMode('pack');
                                  setUsageType('consume');
                                  setConsumeQty(String(Math.min(1, batch.qty)));
                                }}
                              >
                                🍽️ Use
                              </button>
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
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" style={{ transform: showAccountPicker ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s', opacity: 0.5 }}><path d="M6 9l6 6 6-6"/></svg>
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
                  return (
                    <div key={idx} className="stock-item-row-builder" style={{ marginTop: 6 }}>
                      {purchaseItems.length > 1 && (
                        <button
                          className="stock-row-delete-btn"
                          onClick={() => handleRemovePurchaseItem(idx)}
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

                      <div className="stock-row-grid-3">
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Qty (Packs)</label>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            placeholder="1"
                            value={item.qty}
                            onFocus={() => {
                              setShowAccountPicker(false);
                              setActiveItemSugIdx(null);
                              setActiveStoreSugIdx(null);
                            }}
                            onChange={e => handlePurchaseItemChange(idx, 'qty', e.target.value)}
                          />
                          {itemErr.qty && <span className="field-error">{itemErr.qty}</span>}
                        </div>
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Pack Unit</label>
                          <select
                            className="form-input"
                            value={item.unit}
                            onFocus={() => {
                              setShowAccountPicker(false);
                              setActiveItemSugIdx(null);
                              setActiveStoreSugIdx(null);
                            }}
                            onChange={e => handlePurchaseItemChange(idx, 'unit', e.target.value)}
                          >
                            <option value="pcs">pcs</option>
                            <option value="packet">packet</option>
                            <option value="box">box</option>
                            <option value="bottle">bottle</option>
                            <option value="kg">kg</option>
                            <option value="litre">litre</option>
                          </select>
                        </div>
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Pack Price (₹)</label>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            placeholder="0"
                            value={item.price}
                            onFocus={() => {
                              setShowAccountPicker(false);
                              setActiveItemSugIdx(null);
                              setActiveStoreSugIdx(null);
                            }}
                            onChange={e => handlePurchaseItemChange(idx, 'price', e.target.value)}
                          />
                        </div>
                      </div>

                      {/* Pack contents multiplier (Size per Unit) */}
                      <div className="stock-row-grid-2">
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Pack Content Size (Optional)</label>
                          <input
                            type="number"
                            step="any"
                            className="form-input"
                            placeholder="e.g. 200 (for 200g)"
                            value={item.sub_qty}
                            onFocus={() => {
                              setShowAccountPicker(false);
                              setActiveItemSugIdx(null);
                              setActiveStoreSugIdx(null);
                            }}
                            onChange={e => handlePurchaseItemChange(idx, 'sub_qty', e.target.value)}
                          />
                        </div>
                        <div className="mgr-edit-field">
                          <label className="stock-builder-lbl">Content Unit (Optional)</label>
                          <select
                            className="form-input"
                            value={item.sub_unit}
                            onFocus={() => {
                              setShowAccountPicker(false);
                              setActiveItemSugIdx(null);
                              setActiveStoreSugIdx(null);
                            }}
                            onChange={e => handlePurchaseItemChange(idx, 'sub_unit', e.target.value)}
                          >
                            <option value="">None (Count Only)</option>
                            <option value="g">g</option>
                            <option value="ml">ml</option>
                            <option value="kg">kg</option>
                            <option value="litre">litre</option>
                          </select>
                        </div>
                      </div>

                      {/* Discount & Store details */}
                      <div className="stock-row-grid-2">
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
                              onFocus={() => {
                                setShowAccountPicker(false);
                                setActiveItemSugIdx(null);
                                setActiveStoreSugIdx(null);
                              }}
                              onChange={e => handlePurchaseItemChange(idx, 'discountValue', e.target.value)}
                            />
                          </div>
                        </div>

                        <div className="mgr-edit-field" style={{ position: 'relative' }}>
                          <label className="stock-builder-lbl">Store Name</label>
                          <input
                            type="text"
                            className="form-input"
                            placeholder="e.g. Walmart, DMart"
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
                        </div>
                      </div>

                      {/* Calculated dynamic unit price display */}
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 2, paddingInline: 2 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>Calculated Entry Price:</span>
                          <span style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>
                            ₹{calculateDiscountedPrice(item).toFixed(2)} / {item.unit} (Total: ₹{(calculateDiscountedPrice(item) * (parseFloat(item.qty) || 0)).toFixed(2)})
                          </span>
                        </div>
                        {item.sub_unit && parseFloat(item.sub_qty) > 1 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--accent)', fontWeight: 600 }}>
                            <span>Pack Total volume:</span>
                            <span>
                              {(parseFloat(item.qty) || 0) * (parseFloat(item.sub_qty) || 1)} {item.sub_unit} (₹{(calculateDiscountedPrice(item) / (parseFloat(item.sub_qty) || 1)).toFixed(3)} / {item.sub_unit})
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Add Item Button below the last item list */}
                <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 10 }}>
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
    </div>
  );
}
