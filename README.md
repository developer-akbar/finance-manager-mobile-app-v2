# FinMan — Personal Finance Manager

A premium dark-themed personal finance app built with **React 18 + Vite + Capacitor 5**.  
Runs natively on Android (SQLite) and in any browser (IndexedDB). No cloud. No accounts. All data stays on your device.

---

## ✨ Features

| Area | What it does |
|------|-------------|
| **Transactions** | Daily & monthly grouped list, income/expense/transfer support, time tracking |
| **Accounts** | Balance per account, group management, drill-down with 6-month balance chart |
| **Categories** | Expense & income breakdown, subcategory drill-down, period filters |
| **Search** | Full-text note/category/account search, period navigation (weekly/monthly/yearly/FY), multi-select with totals |
| **Dashboard** | Net worth with privacy toggle, saving rate, spending analytics, yearly analysis table, tip of the day |
| **Analytics** | Average monthly & yearly spending, highest spending month, year-over-year table |
| **Import** | Money Manager XLS/XLSX/CSV — auto-detects Indian date format, handles Transfers correctly |
| **Export** | Full transaction CSV export |
| **Budgets** | Per-category monthly/yearly budgets with progress bars |
| **PIN Lock** | App locks only when backgrounded for 5+ seconds |
| **Settings** | Account groups, category/subcategory management, profile name, PIN setup |

---

## 🖥 Run Locally (Browser)

### Prerequisites
- **Node.js 18+** — check with `node -v`

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Start dev server
npm run dev
# Opens at http://localhost:5173
```

> Data is saved in browser IndexedDB — it persists across sessions.

---

## 📱 Run on Android (Android Studio)

### Prerequisites

| Tool | Version | How to get |
|------|---------|------------|
| Node.js | 18+ | https://nodejs.org |
| Android Studio | Hedgehog+ | https://developer.android.com/studio |
| JDK | 17 | Bundled with Android Studio, or https://adoptium.net |
| Android SDK | API 33+ | Android Studio → SDK Manager |

---

### First-time Setup

#### Step 1 — Install dependencies

```bash
npm install
npm install @capacitor/core @capacitor/cli @capacitor/android
```

#### Step 2 — Build the web app

```bash
npm run build
```

#### Step 3 — Add Android platform

```bash
npx cap add android
```

> Skip if an `android/` folder already exists.

#### Step 4 — Configure Android project

**a) Minimum SDK** — open `android/variables.gradle`:
```gradle
minSdkVersion = 22
```

**b) Register SQLite plugin** — open `android/app/src/main/java/com/akbar/finman/MainActivity.java`:
```java
package com.akbar.finman;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.capacitorjs.plugins.sqlite.CapacitorSQLite;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CapacitorSQLite.class);
        super.onCreate(savedInstanceState);
    }
}
```

**c) Set JDK 17** — Android Studio → `File → Settings → Build Tools → Gradle` → set **Gradle JDK** to **JDK 17**

#### Step 5 — Apply app icon

```bash
bash copy-icons.sh
```

This copies the FinMan icon into all Android `mipmap-*` folders automatically.

#### Step 6 — Sync and open

```bash
npx cap sync android
npx cap open android
```

#### Step 7 — Run

1. Connect your phone via USB with **USB Debugging** enabled, or create an emulator via `Tools → Device Manager`
2. Select device in the toolbar
3. Press **▶ Run** (`Shift+F10`)

---

### Subsequent Changes

```bash
# After any code change:
npm run build
npx cap sync android
# Then Run again from Android Studio
```

Or use live reload (phone and PC must be on same Wi-Fi):

```bash
npx cap run android --live-reload
```

---

## 🎨 App Icon

Icon files live in `public/`:

| File | Size | Use |
|------|------|-----|
| `icon.png` | 1024×1024 | Master source |
| `icon-mdpi.png` | 48×48 | Android mdpi |
| `icon-hdpi.png` | 72×72 | Android hdpi |
| `icon-xhdpi.png` | 96×96 | Android xhdpi |
| `icon-xxhdpi.png` | 144×144 | Android xxhdpi |
| `icon-xxxhdpi.png` | 192×192 | Android xxxhdpi |

Run `bash copy-icons.sh` after `npx cap sync android` to apply them.  
Then in Android Studio: **Build → Clean Project → Rebuild**.

---

## 📤 Import Format

FinMan imports from **Money Manager (Android)** XLS exports.

**How to export from Money Manager:**  
`Menu → Backup → Excel (XLS)` — use the full export.

**Column structure** (auto-detected):

| Column | Content |
|--------|---------|
| Date | `dd/mm/yyyy HH:MM:SS` (Indian format) |
| Account | Source account name |
| Category | Expense category OR destination account for Transfers |
| Subcategory | Sub-category |
| Note | Transaction note |
| INR | Amount in Indian Rupees |
| Income/Expense | `Income`, `Expense`, `Transfer-Out`, `Transfer-In` |
| Description | Extended note |

**Import modes:**
- **Override** — clears existing data, imports fresh
- **Merge** — adds new transactions, skips duplicates

---

## 🗃 Data Storage

| Platform | Storage |
|----------|---------|
| Android | SQLite via `@capacitor-community/sqlite` |
| Browser | IndexedDB |

No cloud sync. No accounts. Data never leaves the device.

---

## 🏗 Tech Stack

```
React 18              UI framework
Vite 5                Build tool  
Capacitor 5           Android bridge
SQLite                Android local storage
IndexedDB             Browser storage
Recharts              Charts
SheetJS (XLSX)        XLS import
Sora                  Display font
JetBrains Mono        Number font
```

---

## 🛠 Troubleshooting

| Issue | Fix |
|-------|-----|
| White screen on launch | `npm run build && npx cap sync android` |
| SQLite crash | Add `registerPlugin(CapacitorSQLite.class)` in `MainActivity.java` |
| Still seeing default icon | Run `bash copy-icons.sh` then **Build → Clean Project → Rebuild** |
| Gradle build fails | `File → Invalidate Caches → Restart` |
| `JAVA_HOME` error | Set JDK 17 in Android Studio Gradle settings |
| `minSdkVersion` error | Set `minSdkVersion = 22` in `android/variables.gradle` |
| Content under status bar | Rebuild — safe area is injected at runtime |

---

## 📦 Git Setup

```bash
git init
git remote add origin https://github.com/developer-akbar/finance-manager-mobile-app-v2.git
git add .
git commit -m "FinMan v2.2.1.0"
git push origin main
```

### Recommended `.gitignore`

```
node_modules/
dist/
android/
ios/
.DS_Store
*.local
```

> Do not commit `android/` — it is generated and large. Commit only `src/`, config files, and `package.json`.

---

## 📋 Change Logs

Version-by-version changelogs are in the [`/change-logs`](./change-logs/) folder.

