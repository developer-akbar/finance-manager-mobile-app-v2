# FinMan v2 — Personal Finance Manager

Modern, offline-first personal finance app built with React + Capacitor + SQLite.

## Stack
- **React 18** + Vite
- **Capacitor 5** (Android + Web)
- **@capacitor-community/sqlite** — offline SQLite storage
- **Recharts** — analytics charts
- **XLSX** — Excel/CSV import
- **Sora + JetBrains Mono** — typography

## Features
- 📊 Dashboard with net worth, budgets, 6-month trend
- ➕ Add/Edit/Delete transactions (Expense, Income, Transfer)
- 🔍 Search with filters (date, type, account, category, sort)
- 📈 Analytics — donut chart, bar chart, category & account breakdown
- 💳 Accounts screen — balance per account, monthly stats
- ⚙️ Settings — import, export, accounts, categories, budgets, PIN lock
- 📥 Import: Excel (.xlsx/.xls), CSV, JSON — same v1 column format
- 📤 Export: CSV download for device transfer / backup
- 🔒 PIN lock — locks after 30s background
- 🌙 Dark premium theme

## Import Format (same as v1)
Columns: `Date, Account, FromAccount, ToAccount, Category, Subcategory, Note, Description, INR, Amount, Currency, Income/Expense, ID`

Date formats supported: `DD/MM/YYYY`, `DD-MM-YYYY`, `YYYY-MM-DD`, Excel serial

## Setup

```bash
npm install
npm run dev          # browser preview
```

## Android Build

```bash
# First time only
npx cap add android

# Every code change
npm run build
npx cap sync
npx cap run android   # select your device
```

### Java requirement
Gradle requires **Java 17+**. In Android Studio:
Settings → Build, Execution, Deployment → Gradle → Gradle JDK → select Java 17

### Android Studio setup (first time)
In `android/app/src/main/java/.../MainActivity.java`:
```java
import com.getcapacitor.community.database.sqlite.CapacitorSQLite;
// inside onCreate, before super:
registerPlugin(CapacitorSQLite.class);
```

In `android/variables.gradle`:
```
minSdkVersion = 22
```

## Project Structure
```
src/
  components/
    Dashboard/      Dashboard screen
    Transactions/   AddTransaction, TransactionItem
    Search/         Search + filters
    Analytics/      Charts, category breakdown
    Accounts/       Account cards
    Settings/       Settings, DataImport, Managers, ProfileSettings
    Common/         PinLock, Toast
    Layout/         Bottom nav layout
  contexts/
    AppContext.jsx  Global state, DB operations
  database/
    db.js           SQLite init
    transactions.js CRUD + bulk import
    accounts.js     Accounts, groups, mapping
    categories.js   Categories + subcategories
    budgets.js      Budget management
    settings.js     Key-value settings
  utils/
    format.js       INR formatting, date helpers, stats utils
  styles/
    globals.css     Complete design system
```
