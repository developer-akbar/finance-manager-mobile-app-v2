import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR } from '../../utils/format.js';
import {
  getInventoryItems,
  addInventoryPurchase,
  consumeInventoryItem,
  deleteInventoryItem
} from '../../database/inventory.js';
import './StockManager.css';

export default function StockManager({ onBack, backInterceptRef }) {
  const { state, load } = useApp();
  const { accounts } = state;

  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('in_stock'); // 'in_stock', 'out_of_stock', 'all'
  const [search, setSearch] = useState('');
  
  // Consumption states
  const [consumingItemId, setConsumingItemId] = useState(null);
  const [consumeQty, setConsumeQty] = useState('');
  const [consumeDate, setConsumeDate] = useState(new Date().toISOString().split('T')[0]);

  // Purchase modal states
  const [showPurchaseModal, setShowPurchaseModal] = useState(false);
  const [purchaseFrom, setPurchaseFrom] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().split('T')[0]);
  const [purchaseItems, setPurchaseItems] = useState([
    { name: '', qty: '', unit: 'pcs', price: '', discounted_price: '', notes: '' }
  ]);
  const [purchaseError, setPurchaseError] = useState('');

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
  }, []);

  // Sync back button intercept
  useEffect(() => {
    if (!backInterceptRef) return;
    if (showPurchaseModal) {
      backInterceptRef.current = () => setShowPurchaseModal(false);
    } else if (consumingItemId) {
      backInterceptRef.current = () => setConsumingItemId(null);
    } else {
      backInterceptRef.current = onBack;
    }
    return () => {
      if (backInterceptRef) backInterceptRef.current = onBack;
    };
  }, [showPurchaseModal, consumingItemId, onBack, backInterceptRef]);

  // Default paid account prefill
  useEffect(() => {
    if (accounts && accounts.length > 0 && !purchaseFrom) {
      const firstSavings = accounts.find(a => !['credit card', 'credit', 'lend', 'borrow', 'stock'].some(k => (a.name || a).toLowerCase().includes(k))) || accounts[0];
      setPurchaseFrom(typeof firstSavings === 'object' ? firstSavings.name : firstSavings);
    }
  }, [accounts, purchaseFrom]);

  // Computed summary metrics
  const summary = useMemo(() => {
    let totalValue = 0;
    let totalItems = 0;
    let outOfStock = 0;
    let lowStock = 0;

    items.forEach(item => {
      const qty = parseFloat(item.qty) || 0;
      const price = parseFloat(item.discounted_price) || parseFloat(item.price) || 0;
      totalValue += qty * price;
      if (qty > 0) {
        totalItems++;
        if (qty <= 1) lowStock++;
      } else {
        outOfStock++;
      }
    });

    return { totalValue, totalItems, outOfStock, lowStock };
  }, [items]);

  // Filtered and searched items
  const filteredItems = useMemo(() => {
    return items.filter(item => {
      const qty = parseFloat(item.qty) || 0;
      const matchesFilter =
        filter === 'all' ? true :
        filter === 'in_stock' ? qty > 0 :
        qty === 0;

      const matchesSearch = item.name.toLowerCase().includes(search.toLowerCase()) ||
        (item.notes || '').toLowerCase().includes(search.toLowerCase());

      return matchesFilter && matchesSearch;
    });
  }, [items, filter, search]);

  // Unique names list for autocomplete/suggestions
  const itemSuggestions = useMemo(() => {
    return [...new Set(items.map(i => i.name))];
  }, [items]);

  const handleConsume = async (item) => {
    const qty = parseFloat(consumeQty);
    if (isNaN(qty) || qty <= 0) return;
    if (qty > item.qty) {
      alert(`Cannot consume more than available stock (${item.qty} ${item.unit || 'units'}).`);
      return;
    }

    try {
      await consumeInventoryItem(item.id, qty, consumeDate);
      setConsumingItemId(null);
      setConsumeQty('');
      await fetchItems();
      await load(); // trigger state reload to update transaction logs & account balances
    } catch (err) {
      console.error(err);
      alert('Failed to update stock quantity');
    }
  };

  const handleAddNewPurchaseItem = () => {
    setPurchaseItems(prev => [
      ...prev,
      { name: '', qty: '', unit: 'pcs', price: '', discounted_price: '', notes: '' }
    ]);
  };

  const handleRemovePurchaseItem = (index) => {
    setPurchaseItems(prev => prev.filter((_, i) => i !== index));
  };

  const handlePurchaseItemChange = (index, field, val) => {
    setPurchaseItems(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: val };
      // Auto-prefill discounted price equal to price if not set yet
      if (field === 'price' && !next[index].discounted_price) {
        next[index].discounted_price = val;
      }
      return next;
    });
  };

  const handleSavePurchase = async () => {
    setPurchaseError('');
    if (!purchaseFrom) {
      setPurchaseError('Please select a payment account.');
      return;
    }

    // Validate items
    const validItems = [];
    for (let i = 0; i < purchaseItems.length; i++) {
      const item = purchaseItems[i];
      if (!item.name.trim()) {
        setPurchaseError(`Item #${i + 1} has no name.`);
        return;
      }
      const qty = parseFloat(item.qty);
      if (isNaN(qty) || qty <= 0) {
        setPurchaseError(`Item #${i + 1} must have a valid quantity.`);
        return;
      }
      validItems.push(item);
    }

    if (validItems.length === 0) {
      setPurchaseError('Please add at least one item.');
      return;
    }

    try {
      await addInventoryPurchase(purchaseFrom, purchaseDate, validItems);
      setShowPurchaseModal(false);
      // Reset items to single blank row
      setPurchaseItems([{ name: '', qty: '', unit: 'pcs', price: '', discounted_price: '', notes: '' }]);
      await fetchItems();
      await load(); // sync transaction list & accounts balances instantly
    } catch (err) {
      console.error(err);
      setPurchaseError('Failed to record stock purchase.');
    }
  };

  const handleDeleteItem = async (id) => {
    if (!window.confirm('Are you sure you want to delete this item from inventory?')) return;
    try {
      await deleteInventoryItem(id);
      await fetchItems();
    } catch (err) {
      console.error(err);
      alert('Failed to delete item.');
    }
  };

  const totalPurchaseSum = useMemo(() => {
    return purchaseItems.reduce((sum, item) => {
      const qty = parseFloat(item.qty) || 0;
      const price = parseFloat(item.discounted_price) || parseFloat(item.price) || 0;
      return sum + (qty * price);
    }, 0);
  }, [purchaseItems]);

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

  return (
    <div className="stock-manager-screen">
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
          onClick={() => setShowPurchaseModal(true)}
        >
          ➕ Purchase
        </button>
      </div>

      <div className="stock-manager-body">
        {/* Summaries */}
        <div className="stock-summary-card">
          <div className="stock-summary-col">
            <div className="stock-summary-label">Total Value</div>
            <div className="stock-summary-val" style={{ color: 'var(--green)' }}>
              {formatINR(summary.totalValue)}
            </div>
          </div>
          <div className="stock-summary-divider" />
          <div className="stock-summary-col">
            <div className="stock-summary-label">Items In Stock</div>
            <div className="stock-summary-val">{summary.totalItems}</div>
          </div>
          <div className="stock-summary-divider" />
          <div className="stock-summary-col">
            <div className="stock-summary-label">Low / Out</div>
            <div className="stock-summary-val" style={{ color: summary.lowStock > 0 ? 'var(--gold)' : 'var(--text-secondary)' }}>
              {summary.lowStock} / {summary.outOfStock}
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
            placeholder="Search items by name..."
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

        {/* Stock list */}
        <div className="stock-item-list">
          {filteredItems.map(item => {
            const isOut = parseFloat(item.qty) <= 0;
            const isConsuming = consumingItemId === item.id;

            return (
              <div key={item.id} className="stock-item-card">
                <div className="stock-item-top">
                  <div className="stock-item-info">
                    <div className="stock-item-icon">{getEmoji(item.name)}</div>
                    <div className="stock-item-details">
                      <div className="stock-item-name">{item.name}</div>
                      <div className="stock-item-meta">
                        {item.purchased_date && `Bought: ${new Date(item.purchased_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`}
                        {item.updated_at && ` · Updated: ${new Date(item.updated_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`}
                      </div>
                    </div>
                  </div>
                  <div className="stock-item-qty-col">
                    <div className={`stock-item-qty ${isOut ? 'out' : ''}`}>
                      {item.qty} {item.unit || 'pcs'}
                    </div>
                    <div className="stock-item-price">
                      {item.discounted_price > 0 && item.discounted_price !== item.price ? (
                        <>
                          <span style={{ textDecoration: 'line-through', marginRight: 4 }}>₹{item.price}</span>
                          <span style={{ color: 'var(--green)', fontWeight: 700 }}>₹{item.discounted_price}</span>
                        </>
                      ) : (
                        `₹${item.price || 0}`
                      )}
                      {item.unit ? ` / ${item.unit}` : ''}
                    </div>
                  </div>
                </div>

                {item.notes && <div className="stock-item-notes">{item.notes}</div>}

                {isConsuming ? (
                  <div className="stock-consume-inline">
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)' }}>Qty to Use:</span>
                    <input
                      type="number"
                      step="any"
                      className="stock-consume-input"
                      value={consumeQty}
                      placeholder={String(item.qty)}
                      onChange={e => setConsumeQty(e.target.value)}
                    />
                    <input
                      type="date"
                      className="stock-consume-input"
                      style={{ width: '110px' }}
                      value={consumeDate}
                      onChange={e => setConsumeDate(e.target.value)}
                    />
                    <button
                      className="stock-btn-action consume"
                      onClick={() => handleConsume(item)}
                      style={{ marginLeft: 'auto' }}
                    >
                      Use
                    </button>
                    <button
                      className="stock-btn-action"
                      onClick={() => setConsumingItemId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="stock-item-actions">
                    <button
                      className="stock-btn-action consume"
                      disabled={isOut}
                      onClick={() => {
                        setConsumingItemId(item.id);
                        setConsumeQty(String(Math.min(1, item.qty)));
                      }}
                    >
                      🍽️ Use Stock
                    </button>
                    <button
                      className="stock-btn-action delete"
                      onClick={() => handleDeleteItem(item.id)}
                    >
                      ✕ Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {filteredItems.length === 0 && (
            <div className="empty-state" style={{ padding: '40px 10px' }}>
              <div className="empty-icon">🥫</div>
              <div className="empty-title">No stock items found</div>
              <div className="empty-desc">Click "➕ Purchase" above to add new grocery stocks!</div>
            </div>
          )}
        </div>
      </div>

      {/* Stock Purchase Modal Form */}
      {showPurchaseModal && (
        <div className="stock-purchase-modal">
          <div className="stock-purchase-content">
            <div className="page-hdr" style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="page-hdr-title">Log Grocery Purchase</div>
              <button
                onClick={() => setShowPurchaseModal(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '1.2rem', cursor: 'pointer', marginLeft: 'auto', padding: '0 8px' }}
              >
                ✕
              </button>
            </div>

            <div className="stock-purchase-body">
              {purchaseError && (
                <div className="form-error" style={{ marginBottom: 10, padding: 8, background: 'rgba(255, 77, 106, 0.1)', borderRadius: 8 }}>
                  ⚠️ {purchaseError}
                </div>
              )}

              {/* Purchase Account & Date */}
              <div className="stock-row-grid-2">
                <div className="mgr-edit-field">
                  <label className="stock-builder-lbl">Paid From</label>
                  <select
                    className="form-input"
                    value={purchaseFrom}
                    onChange={e => setPurchaseFrom(e.target.value)}
                  >
                    <option value="">Select Account</option>
                    {(accounts || []).map(a => {
                      const name = typeof a === 'object' ? a.name : a;
                      return <option key={name} value={name}>{name}</option>;
                    })}
                  </select>
                </div>
                <div className="mgr-edit-field">
                  <label className="stock-builder-lbl">Purchase Date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={purchaseDate}
                    onChange={e => setPurchaseDate(e.target.value)}
                  />
                </div>
              </div>

              {/* Items list */}
              <div style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--text-secondary)' }}>Items List</span>
                  <button
                    className="stock-btn-action"
                    onClick={handleAddNewPurchaseItem}
                    style={{ padding: '4px 10px', fontSize: '0.68rem' }}
                  >
                    ➕ Add Item
                  </button>
                </div>

                {purchaseItems.map((item, idx) => (
                  <div key={idx} className="stock-item-row-builder">
                    {purchaseItems.length > 1 && (
                      <button
                        className="stock-row-delete-btn"
                        onClick={() => handleRemovePurchaseItem(idx)}
                        title="Remove item"
                      >
                        ✕
                      </button>
                    )}

                    <div className="mgr-edit-field">
                      <label className="stock-builder-lbl">Item Name</label>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="e.g. Milk, Rice, Sugar"
                        value={item.name}
                        list={`stock-suggestions-${idx}`}
                        onChange={e => handlePurchaseItemChange(idx, 'name', e.target.value)}
                      />
                      <datalist id={`stock-suggestions-${idx}`}>
                        {itemSuggestions.map(s => <option key={s} value={s} />)}
                      </datalist>
                    </div>

                    <div className="stock-row-grid-3">
                      <div className="mgr-edit-field">
                        <label className="stock-builder-lbl">Qty</label>
                        <input
                          type="number"
                          step="any"
                          className="form-input"
                          placeholder="1"
                          value={item.qty}
                          onChange={e => handlePurchaseItemChange(idx, 'qty', e.target.value)}
                        />
                      </div>
                      <div className="mgr-edit-field">
                        <label className="stock-builder-lbl">Unit</label>
                        <select
                          className="form-input"
                          value={item.unit}
                          onChange={e => handlePurchaseItemChange(idx, 'unit', e.target.value)}
                        >
                          <option value="pcs">pcs</option>
                          <option value="kg">kg</option>
                          <option value="litre">litre</option>
                          <option value="packet">packet</option>
                          <option value="box">box</option>
                          <option value="g">g</option>
                          <option value="ml">ml</option>
                        </select>
                      </div>
                      <div className="mgr-edit-field">
                        <label className="stock-builder-lbl">Unit Price (₹)</label>
                        <input
                          type="number"
                          step="any"
                          className="form-input"
                          placeholder="Price"
                          value={item.price}
                          onChange={e => handlePurchaseItemChange(idx, 'price', e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="stock-row-grid-2">
                      <div className="mgr-edit-field">
                        <label className="stock-builder-lbl">Disc. Price (₹)</label>
                        <input
                          type="number"
                          step="any"
                          className="form-input"
                          placeholder="Discounted"
                          value={item.discounted_price}
                          onChange={e => handlePurchaseItemChange(idx, 'discounted_price', e.target.value)}
                        />
                      </div>
                      <div className="mgr-edit-field">
                        <label className="stock-builder-lbl">Notes</label>
                        <input
                          type="text"
                          className="form-input"
                          placeholder="Brand / details"
                          value={item.notes}
                          onChange={e => handlePurchaseItemChange(idx, 'notes', e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Grand Total display */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  padding: '12px 14px',
                  marginTop: 10,
                  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)'
                }}
              >
                <span style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--text-secondary)' }}>Grand Total:</span>
                <span style={{ fontSize: '1.25rem', fontWeight: 900, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
                  {formatINR(totalPurchaseSum)}
                </span>
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
