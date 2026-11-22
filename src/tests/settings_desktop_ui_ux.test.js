import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Settings Desktop UI/UX Refinement — Category and Account Settings', () => {
  const settingsJsxPath = path.resolve('src/components/Settings/Settings.jsx');
  const settingsCssPath = path.resolve('src/components/Settings/Settings.css');
  const jsxContent = fs.readFileSync(settingsJsxPath, 'utf8');
  const cssContent = fs.readFileSync(settingsCssPath, 'utf8');

  it('1. Settings subpage container wraps Accounts and Categories manager contents', () => {
    assert.ok(jsxContent.includes('settings-subpage-container'), 'Settings.jsx must use settings-subpage-container');
    assert.ok(cssContent.includes('.settings-subpage-container'), 'Settings.css must define .settings-subpage-container');
    assert.ok(cssContent.includes('max-width: var(--content-max-w, 1440px)'), 'Container must have max-width target of ~1440px');
  });

  it('2. Category Settings redesign: Add Category grid layout (1fr, 180px, 92px)', () => {
    assert.ok(jsxContent.includes('mgr-form-grid-cat'), 'Add Category must use .mgr-form-grid-cat');
    assert.ok(cssContent.includes('.mgr-form-grid-cat'), 'Settings.css must define .mgr-form-grid-cat');
    assert.ok(cssContent.includes('grid-template-columns: 1fr 180px 92px'), 'Desktop grid must allocate 1fr for Name, 180px for Type, and ~90px for Add');
    assert.ok(cssContent.includes('align-items: flex-end'), 'Controls must be vertically aligned with labels above');
  });

  it('3. Category Settings redesign: Add Subcategory grid layout (1fr, 1fr, 92px)', () => {
    assert.ok(jsxContent.includes('mgr-form-grid-subcat'), 'Add Subcategory must use .mgr-form-grid-subcat');
    assert.ok(cssContent.includes('.mgr-form-grid-subcat'), 'Settings.css must define .mgr-form-grid-subcat');
    assert.ok(cssContent.includes('grid-template-columns: 1fr 1fr 92px'), 'Desktop grid must allocate 1fr for Parent, 1fr for Subcategory, and ~90px for Add');
  });

  it('4. Category Settings: Field labels & inputs have readable typography and consistent heights', () => {
    assert.ok(jsxContent.includes('mgr-label'), 'Forms must use .mgr-label');
    assert.ok(jsxContent.includes('mgr-input-lg'), 'Inputs must use .mgr-input-lg');
    assert.ok(jsxContent.includes('mgr-btn-lg'), 'Add buttons must use .mgr-btn-lg');
    assert.ok(cssContent.includes('height: 42px'), 'Standard input/button height should be 40-44px');
  });

  it('5. Category lists: Constrained max-width on desktop, readable typography and subtle hover', () => {
    assert.ok(cssContent.includes('.settings-subpage-container .mgr-list'), 'List in settings subpage must have responsive rules');
    assert.ok(cssContent.includes('max-width: 960px'), 'List must be constrained to ~960px on desktop');
    assert.ok(cssContent.includes('.settings-subpage-container .mgr-list-row:hover'), 'Must have subtle row hover styling');
  });

  it('6. Account Settings: Account groups and add account bars expand across list width (max-width 960px)', () => {
    assert.ok(jsxContent.includes('mgr-add-bar'), 'Add Group and Add Account must use .mgr-add-bar');
    assert.ok(cssContent.includes('.mgr-add-bar'), 'Settings.css must define .mgr-add-bar');
    assert.ok(cssContent.includes('max-width: 960px'), 'Add bar must match card list max-width 960px');
    assert.ok(cssContent.includes('width: 100%'), 'Add bar must occupy full container width');
    assert.ok(cssContent.includes('.mgr-add-bar .form-input'), 'Form input inside add bar must flex to fill available space');
  });

  it('7. Account Edit Form: Structured card layout with max-width ~960px', () => {
    assert.ok(jsxContent.includes('mgr-edit-card'), 'renderEditPanel must render .mgr-edit-card');
    assert.ok(cssContent.includes('.mgr-edit-card'), 'Settings.css must define .mgr-edit-card');
    assert.ok(cssContent.includes('max-width: 960px'), 'Form card must be constrained to 960-1000px on desktop');
  });

  it('8. Account Edit Form: Row 2 has 50% Group and 50% Account Type in 2 columns', () => {
    assert.ok(jsxContent.includes('mgr-grid-2'), 'Group and Account Type must be in .mgr-grid-2');
    assert.ok(cssContent.includes('.mgr-grid-2'), 'Settings.css must define .mgr-grid-2');
    assert.ok(cssContent.includes('grid-template-columns: 1fr 1fr'), '.mgr-grid-2 must have 2 equal columns on desktop');
  });

  it('9. Account Edit Form: Distinct Credit Card Settings panel with statement, due date, and waiver config', () => {
    assert.ok(jsxContent.includes('mgr-cc-panel'), 'Credit Card settings must use .mgr-cc-panel');
    assert.ok(jsxContent.includes('mgr-cc-waiver-section'), 'Waiver settings must use .mgr-cc-waiver-section');
    assert.ok(jsxContent.includes('⚙️ Configure Waiver'), 'Configure waiver button must be present');
    assert.ok(jsxContent.includes('Annual Fee &amp; Waiver Settings'), 'Waiver section heading must be present');
    assert.ok(jsxContent.includes('Billing:'), 'Billing cycle preview must be under Statement Date');
    assert.ok(jsxContent.includes('Due:'), 'Payment due preview must be under Payment Due Days');
  });

  it('10. Account Edit Form: Masked preview for card last 4 digits and sub-accounts section', () => {
    assert.ok(jsxContent.includes('Card / Account Last 4 Digits'), 'Last 4 digits field must exist');
    assert.ok(jsxContent.includes('Masked preview: ••••'), 'Masked preview must be shown below last 4 digits');
    assert.ok(jsxContent.includes('Sub Accounts'), 'Sub Accounts section must exist');
  });

  it('11. Account Edit Form: Right-aligned Cancel and Save Changes buttons, not full-width', () => {
    assert.ok(jsxContent.includes('mgr-form-actions'), 'Edit form must use .mgr-form-actions');
    assert.ok(jsxContent.includes('mgr-action-btn'), 'Buttons must use .mgr-action-btn');
    assert.ok(cssContent.includes('justify-content: flex-end'), 'Actions must be right-aligned on desktop');
    assert.ok(jsxContent.includes('btn btn-ghost mgr-action-btn'), 'Cancel must use neutral secondary ghost style');
    assert.ok(jsxContent.includes('btn btn-primary mgr-action-btn'), 'Save Changes must use primary green style');
    assert.ok(jsxContent.includes('Save Changes'), 'Button label must be Save Changes');
  });

  it('12. Mobile responsiveness: Compact form actions avoiding full-width button stretching', () => {
    assert.ok(cssContent.includes('@media (max-width: 640px)'), 'Mobile media queries must exist for grids');
    assert.ok(cssContent.includes('.mgr-action-btn'), 'Action buttons must have responsive sizing');
    assert.ok(cssContent.includes('justify-content: flex-end'), 'Actions maintain right alignment');
  });

  it('13. Compact Inline Edit Row: Category and Subcategory Rename have input, Cancel, and Save on the exact same row', () => {
    assert.ok(jsxContent.includes('Editing Category:'), 'Category rename must have explicit heading "Editing Category:"');
    assert.ok(jsxContent.includes('Editing Subcategory:'), 'Subcategory rename must have explicit heading "Editing Subcategory:"');
    assert.ok(jsxContent.includes('mgr-inline-edit-card'), 'Must use .mgr-inline-edit-card container');
    assert.ok(jsxContent.includes('mgr-inline-edit-row'), 'Must use .mgr-inline-edit-row flex layout');
    assert.ok(jsxContent.includes('mgr-inline-edit-warn'), 'Warning must be below input row');
    assert.ok(cssContent.includes('.mgr-inline-edit-row'), 'CSS must define .mgr-inline-edit-row');
    assert.ok(cssContent.includes('display: flex'), '.mgr-inline-edit-row must be flex container');
    assert.ok(cssContent.includes('gap: 10px'), '.mgr-inline-edit-row must have clean gap');
  });

  it('14. Category and Subcategory Hierarchy: Nested indentation, branch icons, and clean background replacing dark grey', () => {
    assert.ok(jsxContent.includes('mgr-tree-container'), 'Expanded subcategories must be inside .mgr-tree-container');
    assert.ok(jsxContent.includes('mgr-tree-row'), 'Subcategories must use .mgr-tree-row');
    assert.ok(jsxContent.includes('mgr-tree-branch'), 'Subcategories must include .mgr-tree-branch');
    assert.ok(jsxContent.includes('└─'), 'Branch indicator must be └─');
    assert.ok(cssContent.includes('.mgr-tree-container'), 'CSS must define .mgr-tree-container');
    assert.ok(cssContent.includes('border-left: 2px solid var(--border)'), 'Tree container must have left border');
    assert.ok(cssContent.includes('margin: 4px 16px 12px 32px'), 'Desktop tree container must have clean indentation');
    assert.ok(cssContent.includes('background: var(--bg-card2)'), 'Tree row must use clean card background rather than heavy grey fill');
  });

  it('15. Contextual "+ Add Subcategory": Inside each expanded category with parent context and inline mini-form', () => {
    assert.ok(jsxContent.includes('mgr-add-child-trigger'), 'Must have .mgr-add-child-trigger button');
    assert.ok(jsxContent.includes('+ Add Subcategory'), 'Must display "+ Add Subcategory" action');
    assert.ok(jsxContent.includes('mgr-inline-add-card'), 'Clicking trigger renders .mgr-inline-add-card');
    assert.ok(jsxContent.includes('Add Subcategory · Parent:'), 'Must show parent category as contextual information');
    assert.ok(jsxContent.includes('handleContextualAddSub'), 'Must implement handleContextualAddSub handler');
  });

  it('16. Reorder Guidance: Integrated inline badge and drag handle tooltips', () => {
    assert.ok(jsxContent.includes('mgr-hdr-badge'), 'Headers must use .mgr-hdr-badge instead of isolated floating text');
    assert.ok(jsxContent.includes('⠿ Drag to reorder'), 'Badge text must be "⠿ Drag to reorder"');
    assert.ok(jsxContent.includes('title="Drag to reorder"'), 'Drag handles must have tooltip "title=\\"Drag to reorder\\""');
    assert.ok(cssContent.includes('.mgr-hdr-badge'), 'CSS must define .mgr-hdr-badge');
  });

  it('17. Explicit State Indicators across Categories and Accounts', () => {
    assert.ok(jsxContent.includes('Editing Category:'), 'Explicit heading for category edit');
    assert.ok(jsxContent.includes('Editing Subcategory:'), 'Explicit heading for subcategory edit');
    assert.ok(jsxContent.includes('Editing Account Group:'), 'Explicit heading for account group edit');
    assert.ok(jsxContent.includes('Editing Account:'), 'Explicit heading for account edit');
    assert.ok(jsxContent.includes('Editing Sub Account:'), 'Explicit heading for sub-account edit');
    assert.ok(jsxContent.includes('Parent Group:'), 'Explicit parent group context in account edit');
    assert.ok(jsxContent.includes('Parent Account:'), 'Explicit parent account context in sub-account edit');
  });

  it('18. Accounts List Hierarchy: Nested subaccounts in All Accounts list with expandable toggle', () => {
    assert.ok(jsxContent.includes('expandedAccts'), 'Must track expanded accounts');
    assert.ok(jsxContent.includes('toggleAcctExpand'), 'Must have toggleAcctExpand handler');
    assert.ok(jsxContent.includes('mgr-tree-container'), 'Must render nested .mgr-tree-container under accounts');
    assert.ok(jsxContent.includes('+ Add Sub Account'), 'Must render contextual "+ Add Sub Account" trigger');
    assert.ok(jsxContent.includes('handleContextualAddSubAcct'), 'Must implement handleContextualAddSubAcct');
    assert.ok(jsxContent.includes('handleSaveRenameSubInline'), 'Must support inline editing of subaccounts in list');
  });

  it('19. Delete Safety Audit: Detailed confirmation dialogs for all 4 deletion operations', () => {
    // 1. removeCat
    assert.ok(jsxContent.includes('title: `Delete Category: ${name}?`'), 'removeCat must use exact category name in title');
    assert.ok(jsxContent.includes('associated transaction(s)'), 'removeCat must warn about associated transactions');
    assert.ok(jsxContent.includes('Unassigned'), 'removeCat must state reassignment to Unassigned fallback');
    
    // 2. removeSub
    assert.ok(jsxContent.includes('title: `Delete Subcategory: ${subName}?`'), 'removeSub must use exact subcategory name in title');
    assert.ok(jsxContent.includes('Parent Category: "${catName}"'), 'removeSub must show parent category context');

    // 3. removeAccount
    assert.ok(jsxContent.includes('title: `Delete Account: ${name}?`'), 'removeAccount must use exact account name in title');
    assert.ok(jsxContent.includes('sub-account(s)'), 'removeAccount must report subaccounts count');
    assert.ok(jsxContent.includes('move this account to the "Ungrouped" section'), 'removeAccount must explain protection of historical transactions');

    // 4. handleDeleteSub
    assert.ok(jsxContent.includes('title: `Delete Sub Account: ${sub.name}?`'), 'handleDeleteSub must use exact sub-account name in title');
    assert.ok(jsxContent.includes('Parent Account: "${acct.name}"'), 'handleDeleteSub must show parent account context');
  });

  it('20. Financial Data and Engine Preservation: No alterations to calculation logic or schemas', () => {
    assert.ok(!jsxContent.includes('delete from transactions'), 'Must never silently delete transactions in UI');
    assert.ok(jsxContent.includes('CreditCardFeeWaiverModal'), 'Credit Card fee waiver modal must be preserved');
  });

  it('21. Mobile Category Forms: Compact horizontal alignment avoiding full-width Add button', () => {
    assert.ok(cssContent.includes('.mgr-form-grid-cat'), 'CSS must define .mgr-form-grid-cat');
    assert.ok(cssContent.includes('grid-template-columns: 1fr 115px auto'), 'Mobile Add Category must use compact horizontal columns');
    assert.ok(cssContent.includes('grid-template-columns: 1fr 1fr auto'), 'Mobile Add Subcategory must use compact horizontal columns');
    assert.ok(cssContent.includes('@media (max-width: 380px)'), 'Narrow mobile fallback query must exist');
  });

  it('22. Responsive Two-Column Layout for Card Identification & Sub Accounts', () => {
    assert.ok(jsxContent.includes('mgr-grid-card-sub'), 'Settings.jsx must use .mgr-grid-card-sub');
    assert.ok(cssContent.includes('.mgr-grid-card-sub'), 'Settings.css must define .mgr-grid-card-sub');
    assert.ok(cssContent.includes('grid-template-columns: 42% 1fr'), 'Grid ratio must be ~42:58 (40:60 to 45:55 range)');
    assert.ok(cssContent.includes('@media (max-width: 768px)'), 'Mobile stacking query must exist for card-sub grid');
  });

  it('23. Modern Trash Icon replaces ✕ across all destructive delete actions', () => {
    assert.ok(jsxContent.includes('function TrashIcon'), 'TrashIcon component must be defined');
    assert.ok(jsxContent.includes('polyline points="3 6 5 6 21 6"'), 'Standard Lucide trash-2 polyline must be used');
    assert.ok(jsxContent.includes('<TrashIcon />') || jsxContent.includes('<TrashIcon size='), 'TrashIcon component must be rendered');
    assert.ok(!jsxContent.includes('className="mgr-del-btn" title="Delete account group" onClick={() => removeGroup(g)}>✕</button>'), 'Group delete must not use ✕');
    assert.ok(!jsxContent.includes('className="mgr-del-btn" title="Delete account" onClick={() => removeAccount(a.name)}>✕</button>'), 'Account delete must not use ✕');
    assert.ok(!jsxContent.includes('className="mgr-del-btn" title="Delete category" onClick={() => removeCat(i)}>✕</button>'), 'Category delete must not use ✕');
  });

  it('24. Accessible labels and tooltips on all delete buttons', () => {
    assert.ok(jsxContent.includes('aria-label="Delete Account Group"'), 'Group delete button must have aria-label');
    assert.ok(jsxContent.includes('title="Delete Account Group"'), 'Group delete button must have title');
    assert.ok(jsxContent.includes('aria-label="Delete Account"'), 'Account delete button must have aria-label');
    assert.ok(jsxContent.includes('title="Delete Account"'), 'Account delete button must have title');
    assert.ok(jsxContent.includes('aria-label="Delete Sub Account"'), 'Subaccount delete button must have aria-label');
    assert.ok(jsxContent.includes('title="Delete Sub Account"'), 'Subaccount delete button must have title');
    assert.ok(jsxContent.includes('aria-label="Delete Category"'), 'Category delete button must have aria-label');
    assert.ok(jsxContent.includes('title="Delete Category"'), 'Category delete button must have title');
    assert.ok(jsxContent.includes('aria-label="Delete Subcategory"'), 'Subcategory delete button must have aria-label');
    assert.ok(jsxContent.includes('title="Delete Subcategory"'), 'Subcategory delete button must have title');
  });

  it('25. Consistent 4-sided input borders across Categories and Accounts', () => {
    assert.ok(cssContent.includes('.settings-subpage-container .form-input'), 'Settings subpage inputs must have dedicated border rule');
    assert.ok(cssContent.includes('border: 1px solid var(--border)'), 'Inputs must have full 4-sided border');
    assert.ok(cssContent.includes('border-radius: var(--r-md, 8px)'), 'Inputs must have rounded borders');
    assert.ok(cssContent.includes('box-shadow: 0 0 0 2px var(--accent-dim)'), 'Inputs must have focus ring');
    assert.ok(cssContent.includes('background: var(--bg-input'), 'Inputs must have background color');
  });

  it('26. Typography consistency: standard item names, labels, section headers, badges and buttons', () => {
    assert.ok(cssContent.includes('.settings-subpage-container .mgr-list-name'), 'List name styling must exist');
    assert.ok(cssContent.includes('font-size: 0.875rem'), 'Item names must be standardized to 0.875rem');
    assert.ok(cssContent.includes('.mgr-label'), 'Field label styling must exist');
    assert.ok(cssContent.includes('font-size: 0.8rem'), 'Field labels must be standardized to 0.8rem');
    assert.ok(cssContent.includes('.mgr-section-hdr'), 'Section header styling must exist');
    assert.ok(cssContent.includes('font-size: 0.9rem'), 'Section headers must be standardized to 0.9rem');
    assert.ok(cssContent.includes('.mgr-section-hdr-hint'), 'Section header hint styling must exist');
    assert.ok(cssContent.includes('font-size: 0.75rem'), 'Hints must be standardized to 0.75rem');
    assert.ok(cssContent.includes('.mgr-badge-count'), 'Badge count styling must exist');
    assert.ok(cssContent.includes('font-size: 0.72rem'), 'Badges must be standardized to 0.72rem');
  });

  it('27. Account Kanban Board is defined and renders Kanban board in Board tab', () => {
    assert.ok(jsxContent.includes('export function AccountKanbanBoard') || jsxContent.includes('function AccountKanbanBoard'), 'AccountKanbanBoard component must be defined');
    assert.ok(jsxContent.includes('<AccountKanbanBoard'), 'AccountsManager must render AccountKanbanBoard when tabMode is kanban');
  });

  it('28. Add Group button is integrated in the Board mode toolbar next to the List/Board toggle', () => {
    assert.ok(jsxContent.includes('mgr-board-add-btn'), 'Toolbar must render .mgr-board-add-btn');
    assert.ok(jsxContent.includes('+ Add Group'), 'Button must display "+ Add Group"');
    assert.ok(jsxContent.includes('className="btn btn-primary mgr-board-add-btn"'), 'Add Group button must have green btn-primary style');
    assert.ok(jsxContent.includes('handleAddGroupPrompt'), 'Clicking Add Group must call handleAddGroupPrompt');
    assert.ok(cssContent.includes('.mgr-tabs-wrap'), 'CSS must define .mgr-tabs-wrap toolbar');
    assert.ok(cssContent.includes('justify-content: space-between'), 'Toolbar must space toggle and Add Group button across the row');
  });

  it('29. Isolated floating button is removed from AccountKanbanBoard', () => {
    assert.ok(!jsxContent.includes('onAddGroup &&'), 'AccountKanbanBoard must not contain isolated onAddGroup button');
  });

  it('30. Toolbar maintains responsive alignment and spacing across desktop and mobile', () => {
    assert.ok(cssContent.includes('.mgr-board-add-btn'), 'CSS must define .mgr-board-add-btn');
    assert.ok(cssContent.includes('max-width: 960px'), 'Toolbar must align with 960px container width');
    assert.ok(cssContent.includes('.settings-subpage-container .kanban-board'), 'Kanban board must have responsive padding');
  });
});
