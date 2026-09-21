export const createEmptyPurchaseItem = () => ({
  _id: 'item_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
  name: '',
  category: 'Groceries',
  customCategory: '',
  brand: '',
  sub_qty: '1',
  sub_unit: 'pcs',
  pack_qty: '1',
  original_qty: '1',
  qty: '1',
  price: '',
  discountType: 'final_price',
  discountValue: '',
  notes: ''
});

export const getItemCalculations = (item) => {
  const price = parseFloat(item.price) || 0;
  const parts = parseFloat(item.original_qty) > 0 ? parseFloat(item.original_qty) : 1;
  const availParts = item.qty !== '' && item.qty !== undefined && !isNaN(parseFloat(item.qty))
    ? Math.max(0, parseFloat(item.qty))
    : parts;

  const mode = item.discountType || 'final_price';
  let discountAmt = 0;
  let paidPrice = price;

  if (mode === 'final_price' || mode === 'finalPrice') {
    if (item.discountValue !== '' && item.discountValue !== undefined && !isNaN(parseFloat(item.discountValue))) {
      paidPrice = Math.max(0, parseFloat(item.discountValue));
      discountAmt = Math.max(0, price - paidPrice);
    } else {
      paidPrice = price;
      discountAmt = 0;
    }
  } else if (mode === 'percentage' || mode === '%') {
    const pct = parseFloat(item.discountValue) || 0;
    discountAmt = price * (pct / 100);
    paidPrice = Math.max(0, price - discountAmt);
  } else {
    // Fixed discount mode ('fixed' / 'fixed_discount' / '₹ Discount')
    const fixedDisc = parseFloat(item.discountValue);
    if (!isNaN(fixedDisc) && fixedDisc > 0) {
      discountAmt = fixedDisc;
      paidPrice = Math.max(0, price - discountAmt);
    } else {
      discountAmt = 0;
      paidPrice = price;
    }
  }

  const saved = price - paidPrice;
  const pricePerUnit = parts > 0 ? (paidPrice / parts) : paidPrice;
  const remainingValue = availParts * pricePerUnit;

  return {
    price,
    parts,
    availParts,
    discountAmt,
    paidPrice,
    saved,
    pricePerUnit,
    remainingValue
  };
};
