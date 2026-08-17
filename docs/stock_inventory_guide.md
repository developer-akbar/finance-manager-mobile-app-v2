# FinMan Stock Inventory System Guide

This guide describes how to use and manage the **Stock Inventory** system in FinMan. It explains the relationship between physical stock items and financial transaction ledgers.

---

## 1. Recording Stock Purchases

When you buy items for your inventory:
1. Open **Stock Inventory** and click `➕ Purchase`.
2. Select the payment account (e.g. Credit Card, Cash, Bank).
3. Enter the **Store Name**, **Purchase Date**, and **Purchase Time**.
4. Add items to the purchase list:
   - **Item Name**: Clean name of the item.
   - **Pack Size**: Weight/Volume/Quantity inside a single package (e.g., `200` with unit `g`, or `1` with unit `pcs`).
   - **Qty (Packs)**: Number of packages bought.
   - **Parts (n)**: Number of physical parts this item can be divided into (e.g., a pack of 4 soap bars has 4 parts).
   - **Original Price / Discount**: Enter the original price of the entire batch and any applicable discount.
5. Click **Save** to write the batch to inventory and automatically create a **Transfer** transaction from your payment account to the **Stock** account.

---

## 2. Using / Consuming Stock Items

Clicking `🍽️ Use` on any stock batch opens a centered popup dialog. The background is fully dimmed, allowing you to focus entirely on the form.

There are three ways to record usage:

### A. 🍽️ Consume
* **Purpose**: Deduct stock consumed in-house (e.g., groceries, toothpaste, detergent).
* **Ledger**: Creates an **Expense** transaction under the **Stock** account.
* **Fields**: Select a Category, Subcategory, Date, Time, and Qty.

### B. 🤝 Lend
* **Purpose**: Deduct stock lent to a friend/family member.
* **Ledger**: Creates an **Expense** transaction under the **Lend** account.
* **Fields**: Enter the person's name, Date, Time, and Qty.

### C. 📋 Instalment
* **Purpose**: Utilize stock items paid for over multiple monthly instalments.
* **Ledger**: Decreases physical stock count and creates a completed **Instalment Schedule** (recurring rule) in the database, automatically logging the individual instalment part transactions on their respective future dates.
* **Fields**: Select Category, Subcategory, Date, Time, Qty, and the number of **Instalment Months** (defaults to 3).

### D. 🔄 Automatic FIFO Batch Rollover
If you consume more than a single batch's remaining quantity (e.g., you have 11 pcs of Oil split as 2 pcs and 9 pcs, and you want to use 10 pcs), you can click **Use** on either batch and enter `10`. FinMan will:
1. Deduct the available quantity from the selected clicked batch first.
2. Automatically deduct the remaining quantity from the next oldest batch of the same item name (FIFO style).
3. Create a single combined transaction ledger entry, logging the respective deductions in the description for accurate auditing.

---

## 3. Keyboard Navigation

* You can dismiss the centered **Use**, **Edit**, or **Purchase** modal popups by pressing the **Escape (Esc)** key or clicking the **Cancel** button.
* Backdrop overlays do not dismiss on touch/click to prevent losing unsaved form inputs.

---

## 4. Understanding Transactions & Stock Sync

* **Physical vs. Financial**: The **Stock Inventory** tracks physical quantities (e.g., pieces, grams). The **Transactions list** tracks money paid or transferred.
* **Editing Transactions**: Modifying or deleting a utilized stock transaction inside the standard **Transactions Edit** screen does not retroactively change the physical count in the inventory batch.
* **Transaction Deletion / Restoring Stock**: When deleting or replacing a consumption transaction, FinMan automatically restores the exact quantities deducted back to **each** respective batch (using tag metadata: `#stock_ref_<itemId>:<qty>`). This prevents stock inflation or batch calculation errors.
* **Tag Protection**: All system tags (`#stock`, `#consumed`, `#lent`, `#instalment`, `#stock_ref_<id>`) are automatically hidden from your transaction suggestions list to keep your tags selection screen clean and clutter-free.
