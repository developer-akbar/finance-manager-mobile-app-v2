/**
 * src/tests/back_button_ui_standardization.test.js
 *
 * Automated Test Suite for FinMan Application-Wide Back Button Standardization.
 * Verifies:
 * 1. Reusable BackButton component specifications (chevron path, stroke, accessibility, className).
 * 2. Shared global CSS styling rules (34px x 34px, 10px radius, hover/active/light-theme).
 * 3. Complete audit across all 17 screens and subpages.
 * 4. Total eradication of inconsistent straight-arrow SVG paths in back-navigation contexts.
 * 5. Elimination of circular/transparent inline overrides in CloudSyncManager.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

test('FinMan — Application-Wide Back Button Standardization Suite', async (t) => {

  await t.test('1. BackButton reusable component exists and adheres to design system', () => {
    const compPath = path.join(projectRoot, 'src/components/Common/BackButton.jsx');
    assert.ok(fs.existsSync(compPath), 'BackButton.jsx component must exist in src/components/Common/');

    const content = fs.readFileSync(compPath, 'utf8');
    assert.ok(content.includes('export default function BackButton'), 'Must export default BackButton function');
    assert.ok(content.includes('className={`back-btn ${className}`.trim()}'), 'Must include .back-btn class');
    assert.ok(content.includes('viewBox="0 0 24 24"'), 'SVG must have viewBox="0 0 24 24"');
    assert.ok(content.includes('strokeWidth="2.5"'), 'SVG strokeWidth must be 2.5');
    assert.ok(content.includes('<path d="M15 18l-6-6 6-6" />'), 'Icon must be standard left chevron path (M15 18l-6-6 6-6)');
    assert.ok(content.includes('aria-label={label}'), 'Must include accessible aria-label');
    assert.ok(content.includes('label = \'Go back\''), 'Must have default label "Go back"');
  });

  await t.test('2. Global CSS defines standardized rounded-square container (34px, 10px radius)', () => {
    const cssPath = path.join(projectRoot, 'src/styles/globals.css');
    const css = fs.readFileSync(cssPath, 'utf8');

    assert.ok(css.includes('.back-btn'), 'globals.css must define .back-btn');
    assert.ok(css.includes('width: 34px'), '.back-btn must have width: 34px');
    assert.ok(css.includes('height: 34px'), '.back-btn must have height: 34px');
    assert.ok(css.includes('border-radius: 10px'), '.back-btn must have border-radius: 10px');
    assert.ok(css.includes('[data-theme="light"] .back-btn'), 'Must define light mode theme overrides');
    assert.ok(css.includes('.back-btn:hover:not(:disabled)'), 'Must define hover transition');
    assert.ok(css.includes('.back-btn:active:not(:disabled)'), 'Must define active press scale transition');
  });

  await t.test('3. CloudSyncManager circular and border-none overrides are removed', () => {
    const cloudSyncPath = path.join(projectRoot, 'src/components/Settings/CloudSyncManager.jsx');
    const content = fs.readFileSync(cloudSyncPath, 'utf8');

    // Ensure back-btn no longer has inline overrides
    const backBtnMatch = content.match(/<button[\s\S]*?className="back-btn"[\s\S]*?borderRadius:\s*'50%'[\s\S]*?<\/button>/);
    assert.equal(backBtnMatch, null, 'Back button with circular border-radius: 50% must not exist');
    assert.ok(content.includes('<BackButton onClick={onBack} label="Back to Settings" />'), 'Must render standard BackButton');
  });

  await t.test('4. All 17 audited components import and render BackButton', () => {
    const auditedFiles = [
      'src/components/Bookmarks/Bookmarks.jsx',
      'src/components/Accounts/InvestmentsPortfolio.jsx',
      'src/components/Accounts/Portfolio/HoldingDetailSheet.jsx',
      'src/components/Accounts/DebtTracker.jsx',
      'src/components/Settings/CloudSyncManager.jsx',
      'src/components/Accounts/Accounts.jsx',
      'src/components/Accounts/CardOptimizer.jsx',
      'src/components/Accounts/StockManager.jsx',
      'src/components/Accounts/WarrantyLocker.jsx',
      'src/components/Categories/Categories.jsx',
      'src/components/Groups/GroupSplitManager.jsx',
      'src/components/Groups/GroupDetail.jsx',
      'src/components/Groups/AddGroupExpense.jsx',
      'src/components/Groups/GroupSettlementSlip.jsx',
      'src/components/Reports/ReportGenerator.jsx',
      'src/components/Settings/Settings.jsx',
      'src/components/Transactions/Transactions.jsx'
    ];

    for (const relPath of auditedFiles) {
      const fullPath = path.join(projectRoot, relPath);
      assert.ok(fs.existsSync(fullPath), `File must exist: ${relPath}`);
      const content = fs.readFileSync(fullPath, 'utf8');
      assert.ok(
        content.includes('BackButton'),
        `File ${relPath} must import and use BackButton component`
      );
      assert.ok(
        content.includes('<BackButton'),
        `File ${relPath} must render <BackButton />`
      );
    }
  });

  await t.test('5. Zero legacy straight-arrow SVG paths remain in back-button contexts', () => {
    const straightArrowPattern = /<path[^>]*d="M19 12H5M12 19l-7-7 7-7"[^>]*\/>/g;
    const componentsDir = path.join(projectRoot, 'src/components');

    function scanDir(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(full);
        } else if (entry.isFile() && (entry.name.endsWith('.jsx') || entry.name.endsWith('.js'))) {
          const content = fs.readFileSync(full, 'utf8');
          const matches = content.match(straightArrowPattern);
          assert.equal(
            matches,
            null,
            `File ${path.relative(projectRoot, full)} should not contain legacy straight-arrow SVG path`
          );
        }
      }
    }

    scanDir(componentsDir);
  });

  await t.test('6. Navigation handlers and props integrity', () => {
    // StockManager: multi-level back handler preserved
    const stockContent = fs.readFileSync(path.join(projectRoot, 'src/components/Accounts/StockManager.jsx'), 'utf8');
    assert.ok(stockContent.includes('activeActivityProduct'), 'StockManager back handler must check activeActivityProduct');
    assert.ok(stockContent.includes('selectedProduct'), 'StockManager back handler must check selectedProduct');
    assert.ok(stockContent.includes('onBack()'), 'StockManager back handler must call onBack()');

    // InvestmentsPortfolio: onBack handler
    const invContent = fs.readFileSync(path.join(projectRoot, 'src/components/Accounts/InvestmentsPortfolio.jsx'), 'utf8');
    assert.ok(invContent.includes('<BackButton onClick={onBack} label="Back to Accounts" className="portfolio-back-btn" />'));

    // HoldingDetailSheet: onClose handler
    const holdingContent = fs.readFileSync(path.join(projectRoot, 'src/components/Accounts/Portfolio/HoldingDetailSheet.jsx'), 'utf8');
    assert.ok(holdingContent.includes('<BackButton onClick={onClose} label="Back to Portfolio" className="portfolio-back-btn" />'));

    // Settings: 8 subpage back handlers
    const settingsContent = fs.readFileSync(path.join(projectRoot, 'src/components/Settings/Settings.jsx'), 'utf8');
    const settingsMatches = settingsContent.match(/<BackButton onClick=\{onBack\} \/>/g);
    assert.equal(settingsMatches?.length, 8, 'Settings.jsx must contain exactly 8 standardized BackButton instances');
  });
});
