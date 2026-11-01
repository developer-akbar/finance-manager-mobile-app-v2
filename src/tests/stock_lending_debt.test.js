import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcileStockLendingDebts,
  isStockLoanTransaction,
  isCashLoanTransaction,
  isStockReturnTransaction,
  isRepaymentTransaction,
  parseStockDebtRefTags
} from '../utils/stockLendingDebt.js';

test('FinMan Stock Lending Debt Reconciliation Suite (Phase 40)', async (suite) => {

  // 1. Exclusion of general cash/personal loans
  await suite.test('1. Exclusion of general cash/personal loans from stock debt', () => {
    const transactions = [
      {
        id: 'txn-cash-loan-tv',
        Date: '10/10/2026',
        FromAccount: 'HDFC Bank',
        ToAccount: 'Lend',
        Category: 'Lend',
        Amount: '19091',
        INR: 19091,
        Note: 'To Mamu',
        Description: 'TV loan',
        Tags: ''
      },
      {
        id: 'txn-cash-loan-eb',
        Date: '12/10/2026',
        FromAccount: 'Cash',
        ToAccount: 'Lend',
        Category: 'Lend',
        Amount: '1188',
        INR: 1188,
        Note: 'To Chota Mamu',
        Description: 'EB bill cash',
        Tags: '#personal #loan'
      },
      {
        id: 'txn-stock-loan-oil',
        Date: '14/10/2026',
        FromAccount: 'Stock',
        ToAccount: 'Lend',
        Category: 'Lend',
        Amount: '154',
        INR: 154,
        Note: 'To Mami',
        Description: 'Lent 1 pcs of Cooking Oil',
        Tags: '#stock #lent #stock_ref_oil_batch_1:1'
      }
    ];

    assert.equal(isCashLoanTransaction(transactions[0]), true, 'TV cash loan is identified as cash loan');
    assert.equal(isCashLoanTransaction(transactions[1]), true, 'EB cash loan is identified as cash loan');
    assert.equal(isCashLoanTransaction(transactions[2]), false, 'Stock loan is NOT a cash loan');
    assert.equal(isStockLoanTransaction(transactions[2]), true, 'Stock loan is identified as stock loan');

    const result = reconcileStockLendingDebts({ transactions });
    assert.equal(result.loans.length, 1, 'Only 1 stock loan is tracked');
    assert.equal(result.loans[0].loanId, 'txn-stock-loan-oil');
    assert.equal(result.summary.totalLentValue, 154, 'Lent value is ₹154 (excluding the ₹20,279 cash loans)');
  });

  // 2. A stock loan with no repayment
  await suite.test('2. A stock loan with no repayment produces pending status and full outstanding balance', () => {
    const transactions = [
      {
        id: 'loan-tide',
        Date: '18/10/2026',
        FromAccount: 'Stock',
        ToAccount: 'Lend',
        Category: 'Lend',
        Amount: '592',
        INR: 592,
        Note: 'To Mami',
        Description: 'Lent 10 pcs of Tide (10 pcs (bought on 8 Oct 2026 from Amazon))',
        Tags: '#stock #lent #stock_ref_batch_tide_1:10'
      }
    ];

    const result = reconcileStockLendingDebts({ transactions });
    assert.equal(result.loans.length, 1);
    const loan = result.loans[0];
    assert.equal(loan.borrower, 'Mami');
    assert.equal(loan.productName, 'Tide');
    assert.equal(loan.lentQty, 10);
    assert.equal(loan.originalValue, 592);
    assert.equal(loan.confirmedRepaidValue, 0);
    assert.equal(loan.returnedValue, 0);
    assert.equal(loan.outstandingValue, 592);
    assert.equal(loan.physicalOutstandingQty, 10);
    assert.equal(loan.status, 'pending');
    assert.equal(result.summary.totalPendingLoansCount, 1);
    assert.equal(result.summary.totalSettledLoansCount, 0);
  });

  // 3. A confirmed, explicitly linked full repayment
  await suite.test('3. Confirmed full repayment via explicit tag #stock_debt_ref_ settles the loan without altering inventory', () => {
    const transactions = [
      {
        id: 'loan-pestro-1',
        Date: '18/10/2026',
        FromAccount: 'Stock',
        ToAccount: 'Lend',
        Amount: '324',
        INR: 324,
        Note: 'To Choti Mami',
        Description: 'Lent 5 pcs of Pestro Gel',
        Tags: '#stock #lent #stock_ref_pestro_batch:5'
      },
      {
        id: 'rep-pestro-1',
        Date: '20/10/2026',
        FromAccount: 'Lend',
        ToAccount: 'Canara Bank',
        Amount: '324',
        INR: 324,
        Note: 'From Choti Mami',
        Description: 'Pestro gel repayment',
        Tags: '#repayment #stock_debt_ref_loan-pestro-1'
      }
    ];

    const result = reconcileStockLendingDebts({ transactions });
    assert.equal(result.loans.length, 1);
    const loan = result.loans[0];
    assert.equal(loan.status, 'settled', 'Loan status is settled');
    assert.equal(loan.confirmedRepaidValue, 324, 'Full ₹324 confirmed repaid');
    assert.equal(loan.outstandingValue, 0, '₹0 outstanding');
    assert.equal(loan.physicalOutstandingQty, 5, 'Physical goods were consumed; physical outstanding quantity remains tracked');
    assert.equal(loan.confirmedRepayments.length, 1);
    assert.equal(loan.confirmedRepayments[0].repaymentTxnId, 'rep-pestro-1');
    assert.equal(result.summary.totalSettledLoansCount, 1);
    assert.equal(result.summary.totalOutstandingValue, 0);
    assert.equal(result.unassignedRepayments.length, 0, 'No unassigned repayments remain');
  });

  // 4. Partial repayments
  await suite.test('4. Partial repayment reduces monetary debt proportionally and marks status as partial', () => {
    const transactions = [
      {
        id: 'loan-ghee',
        Date: '01/10/2026',
        FromAccount: 'Stock',
        ToAccount: 'Lend',
        Amount: '600',
        INR: 600,
        Note: 'To Haseena',
        Description: 'Lent 1 pcs of Pure Ghee 1L',
        Tags: '#stock #lent #stock_ref_ghee_1:1'
      },
      {
        id: 'rep-ghee-part',
        Date: '10/10/2026',
        FromAccount: 'Lend',
        ToAccount: 'HDFC Bank',
        Amount: '250',
        INR: 250,
        Note: 'From Haseena',
        Description: 'Partial Ghee',
        Tags: '#repayment #stock_debt_ref_loan-ghee:250'
      }
    ];

    const result = reconcileStockLendingDebts({ transactions });
    const loan = result.loans[0];
    assert.equal(loan.status, 'partial');
    assert.equal(loan.confirmedRepaidValue, 250);
    assert.equal(loan.outstandingValue, 350);
    assert.equal(result.summary.totalOutstandingValue, 350);
    assert.equal(result.summary.totalConfirmedRepaidValue, 250);
  });

  // 5. Multiple repayments for one loan
  await suite.test('5. Multiple partial repayments cumulatively settle one stock loan', () => {
    const transactions = [
      {
        id: 'loan-almonds',
        Date: '05/09/2026',
        FromAccount: 'Stock',
        ToAccount: 'Lend',
        Amount: '800',
        INR: 800,
        Note: 'To Rahamat',
        Description: 'Lent 1 kg of Almonds',
        Tags: '#stock #lent #stock_ref_almonds:1'
      },
      {
        id: 'rep-almonds-1',
        Date: '15/09/2026',
        FromAccount: 'Lend',
        ToAccount: 'Cash',
        Amount: '300',
        INR: 300,
        Note: 'From Rahamat',
        Tags: '#repayment #stock_debt_ref_loan-almonds:300'
      },
      {
        id: 'rep-almonds-2',
        Date: '25/09/2026',
        FromAccount: 'Lend',
        ToAccount: 'Cash',
        Amount: '500',
        INR: 500,
        Note: 'From Rahamat',
        Tags: '#repayment #stock_debt_ref_loan-almonds:500'
      }
    ];

    const result = reconcileStockLendingDebts({ transactions });
    const loan = result.loans[0];
    assert.equal(loan.status, 'settled');
    assert.equal(loan.confirmedRepaidValue, 800);
    assert.equal(loan.outstandingValue, 0);
    assert.equal(loan.confirmedRepayments.length, 2);
    assert.equal(loan.confirmedRepayments[0].amount, 300);
    assert.equal(loan.confirmedRepayments[1].amount, 500);
  });

  // 6. Ambiguous repayments remain unassigned
  await suite.test('6. Generic repayments without explicit stock references remain strictly unassigned', () => {
    const transactions = [
      {
        id: 'loan-soap',
        Date: '01/10/2026',
        FromAccount: 'Stock',
        ToAccount: 'Lend',
        Amount: '200',
        INR: 200,
        Note: 'To Shameem Mami',
        Description: 'Lent 4 pcs of Soap',
        Tags: '#stock #lent #stock_ref_soap_1:4'
      },
      {
        id: 'rep-generic-pool',
        Date: '15/10/2026',
        FromAccount: 'Lend',
        ToAccount: 'Bank',
        Amount: '1000',
        INR: 1000,
        Note: 'From Shameem Mami',
        Description: '', // Empty description
        Tags: ''
      }
    ];

    const result = reconcileStockLendingDebts({ transactions });
    const loan = result.loans[0];
    assert.equal(loan.status, 'pending', 'Loan must NOT be settled by unassigned generic payment');
    assert.equal(loan.outstandingValue, 200, 'Full ₹200 remains outstanding');
    assert.equal(result.unassignedRepayments.length, 1);
    assert.equal(result.unassignedRepayments[0].txnId, 'rep-generic-pool');
    assert.equal(result.unassignedRepayments[0].unallocatedAmount, 1000);
    assert.equal(result.unassignedRepayments[0].reason, 'UNASSIGNED_GENERIC_REPAYMENT');
  });

  // 7. One repayment cannot be allocated beyond its amount or counted twice
  await suite.test('7. Repayment capacity clamping prevents over-allocation and double counting across loans', () => {
    const transactions = [
      {
        id: 'loan-A',
        Date: '01/10/2026',
        FromAccount: 'Stock',
        ToAccount: 'Lend',
        Amount: '300',
        INR: 300,
        Note: 'To Aslam',
        Description: 'Lent item A',
        Tags: '#stock #lent'
      },
      {
        id: 'loan-B',
        Date: '02/10/2026',
        FromAccount: 'Stock',
        ToAccount: 'Lend',
        Amount: '300',
        INR: 300,
        Note: 'To Aslam',
        Description: 'Lent item B',
        Tags: '#stock #lent'
      },
      {
        id: 'rep-split-try-overspend',
        Date: '10/10/2026',
        FromAccount: 'Lend',
        ToAccount: 'Bank',
        Amount: '400', // Total payment is only ₹400
        INR: 400,
        Note: 'From Aslam',
        // Tries to claim 300 for A and 300 for B (600 total)
        Tags: '#stock_debt_ref_loan-A:300 #stock_debt_ref_loan-B:300'
      }
    ];

    const result = reconcileStockLendingDebts({ transactions });
    const loanA = result.loans.find(l => l.loanId === 'loan-A');
    const loanB = result.loans.find(l => l.loanId === 'loan-B');

    assert.equal(loanA.confirmedRepaidValue, 300, 'Loan A claims ₹300');
    assert.equal(loanB.confirmedRepaidValue, 100, 'Loan B only gets the remaining ₹100 capacity (400 - 300)');
    assert.equal(loanB.outstandingValue, 200, 'Loan B has ₹200 remaining outstanding');
    assert.equal(result.summary.totalConfirmedRepaidValue, 400, 'Total repaid cannot exceed the ₹400 transaction amount');
  });

  // 8. Physical returns restore inventory exactly once
  await suite.test('8. Physical return restores inventory quantity, cancels monetary debt, and is recorded distinctly', () => {
    const transactions = [
      {
        id: 'loan-duster',
        Date: '01/10/2026',
        FromAccount: 'Stock',
        ToAccount: 'Lend',
        Amount: '200',
        INR: 200,
        Note: 'To Fahim',
        Description: 'Lent 2 pcs of Microfiber Duster',
        Tags: '#stock #lent #stock_ref_duster_batch:2'
      },
      {
        id: 'return-duster-phys',
        Date: '12/10/2026',
        FromAccount: 'Lend',
        ToAccount: 'Stock', // Destination is Stock
        Amount: '200',
        INR: 200,
        Note: 'Return from Fahim',
        Description: 'Returned 2 pcs of Microfiber Duster',
        Tags: '#stock #return #stock_ref_duster_batch:2 #stock_debt_ref_loan-duster'
      }
    ];

    assert.equal(isStockReturnTransaction(transactions[1]), true);
    const result = reconcileStockLendingDebts({ transactions });
    const loan = result.loans[0];

    assert.equal(loan.status, 'settled');
    assert.equal(loan.returnedQty, 2, '2 physical pcs returned to stock');
    assert.equal(loan.physicalOutstandingQty, 0, 'Zero physical pcs outstanding');
    assert.equal(loan.returnedValue, 200, 'Full ₹200 credited by physical return');
    assert.equal(loan.confirmedRepaidValue, 0, 'Confirmed monetary repaid is 0 (goods were returned, not bought)');
    assert.equal(loan.outstandingValue, 0);
    assert.equal(loan.physicalReturns.length, 1);
  });

  // 9. Partial returns and valuation uncertainty
  await suite.test('9. Partial physical return calculates exact proportional credit and surfaces valuation clarity', () => {
    const transactions = [
      {
        id: 'loan-shampoo-bottles',
        Date: '01/09/2026',
        FromAccount: 'Stock',
        ToAccount: 'Lend',
        Amount: '600', // 2 bottles for 600 -> unitPrice = 300
        INR: 600,
        Note: 'To Abid',
        Description: 'Lent 2 pcs of Herbal Shampoo 500ml',
        Tags: '#stock #lent'
      },
      {
        id: 'return-shampoo-one',
        Date: '15/09/2026',
        FromAccount: 'Lend',
        ToAccount: 'Stock',
        Amount: '300',
        INR: 300,
        Note: 'Return from Abid',
        Description: 'Returned 1 pcs of Herbal Shampoo 500ml',
        Tags: '#stock #return #stock_debt_ref_loan-shampoo-bottles'
      }
    ];

    const result = reconcileStockLendingDebts({ transactions });
    const loan = result.loans[0];

    assert.equal(loan.status, 'partial');
    assert.equal(loan.returnedQty, 1, '1 bottle returned');
    assert.equal(loan.physicalOutstandingQty, 1, '1 bottle remains physically outstanding');
    assert.equal(loan.returnedValue, 300, '₹300 monetary credit calculated');
    assert.equal(loan.outstandingValue, 300, '₹300 monetary balance remains');
  });

  // 10. Historical loans without structured references
  await suite.test('10. Historical text-based loans without structured tags parse reliably without errors', () => {
    const transactions = [
      {
        id: 'hist-loan-legacy',
        Date: '14/05/2023',
        FromAccount: 'Stock',
        ToAccount: 'Lend',
        Category: 'Lend',
        Amount: '354',
        INR: 354,
        Note: 'To Bhaijan',
        Description: 'Lent 2 pcs of Rin detergent bar',
        Tags: '' // Empty legacy tags
      }
    ];

    const result = reconcileStockLendingDebts({ transactions });
    assert.equal(result.loans.length, 1);
    const loan = result.loans[0];
    assert.equal(loan.borrower, 'Bhaijan');
    assert.equal(loan.productName, 'Rin detergent bar');
    assert.equal(loan.originalValue, 354);
    assert.equal(loan.outstandingValue, 354);
  });

  // 11. Edit/delete recalculation and invalid/dangling references
  await suite.test('11. Dangling or invalid loan references do not crash and surface in unassigned repayments', () => {
    const transactions = [
      {
        id: 'rep-dangling',
        Date: '20/10/2026',
        FromAccount: 'Lend',
        ToAccount: 'Cash',
        Amount: '450',
        INR: 450,
        Note: 'From Arshad',
        Tags: '#repayment #stock_debt_ref_deleted-loan-uuid-1234'
      }
    ];

    const result = reconcileStockLendingDebts({ transactions });
    assert.equal(result.loans.length, 0, 'No loans exist');
    assert.equal(result.unassignedRepayments.length, 1, 'Dangling repayment safely surfaced in unassigned pool');
    assert.equal(result.unassignedRepayments[0].txnId, 'rep-dangling');
    assert.equal(result.unassignedRepayments[0].unallocatedAmount, 450);
  });

  // 12. Pestro Gel's date anomaly remains a suggestion
  await suite.test('12. Pestro Gel date anomaly (repayment 15/10 preceding loan 18/10) remains a suggested match, not auto-settled', () => {
    const transactions = [
      {
        id: 'loan-pestro-oct18',
        Date: '18/10/2026',
        FromAccount: 'Stock',
        ToAccount: 'Lend',
        Amount: '324',
        INR: 324,
        Note: 'To choti mami',
        Description: 'Lent 5 pcs of Pestro Gel (5 pcs (bought on 8 Oct 2026))',
        Tags: '#stock #lent #stock_ref_2026-10-08_batch_3:5'
      },
      {
        id: 'rep-pestro-oct15',
        Date: '15/10/2026', // 3 days BEFORE the recorded loan
        FromAccount: 'Lend',
        ToAccount: 'Axis FK',
        Amount: '324',
        INR: 324,
        Note: 'From Choti mami',
        Description: 'Pestro gel 5L',
        Tags: '' // No explicit tag yet
      }
    ];

    const result = reconcileStockLendingDebts({ transactions });
    const loan = result.loans[0];

    assert.equal(loan.status, 'pending', 'Must NOT be automatically marked settled');
    assert.equal(loan.confirmedRepaidValue, 0, 'Confirmed repaid is 0');
    assert.equal(loan.outstandingValue, 324, 'Full ₹324 remains outstanding pending user confirmation');
    assert.equal(loan.suggestedRepayments.length, 1, 'Recorded as a suggested repayment');
    assert.equal(loan.suggestedRepayments[0].reason, 'DATE_PRECEDES_LOAN');
    assert.equal(loan.suggestedRepayments[0].repaymentTxnId, 'rep-pestro-oct15');
    assert.equal(result.unassignedRepayments.length, 1, 'Also visible in unassigned repayments suspense pool');
  });

  // 13. Santoor Red remains unassigned
  await suite.test('13. Santoor Red repayment with matching amount but empty description remains unassigned', () => {
    const transactions = [
      {
        id: 'loan-santoor-mamu',
        Date: '11/10/2026',
        FromAccount: 'Stock',
        ToAccount: 'Lend',
        Amount: '188',
        INR: 188,
        Note: 'to mamu',
        Description: 'Lent 8 pcs of Santoor Red (8 pcs (bought on 8 Oct 2026))',
        Tags: '#stock #lent #stock_ref_2026-10-08_batch_1:8'
      },
      {
        id: 'rep-mamu-188-empty-desc',
        Date: '23/10/2026',
        FromAccount: 'Lend',
        ToAccount: 'Canara Bank',
        Amount: '188',
        INR: 188,
        Note: 'From Mamu',
        Description: '', // Empty description, no product mention!
        Tags: ''
      }
    ];

    const result = reconcileStockLendingDebts({ transactions });
    const loan = result.loans[0];

    assert.equal(loan.status, 'pending', 'Loan must NOT be settled without explicit product evidence');
    assert.equal(loan.confirmedRepaidValue, 0);
    assert.equal(loan.outstandingValue, 188);
    assert.equal(result.unassignedRepayments.length, 1);
    assert.equal(result.unassignedRepayments[0].reason, 'UNASSIGNED_AMOUNT_MATCH_NO_PRODUCT_TEXT');
    assert.deepEqual(result.unassignedRepayments[0].candidateLoanIds, ['loan-santoor-mamu'], 'Loan is surfaced as advisory candidate');
  });

  // 14. Compatibility with the Dabur Amla installment fix
  await suite.test('14. Dabur Amla historical loan is tracked independently from the home consumption installment schedule', () => {
    const transactions = [
      // 1. Purchase of 2 bottles
      {
        id: 'dabur-purchase',
        Date: '18/01/2026',
        FromAccount: 'HDFC',
        ToAccount: 'Stock',
        Amount: '262',
        INR: 262,
        Description: 'Flipkart\n\nDabur amla Stock unavailable 550ml*2: 291: @131*2'
      },
      // 2. Loan of bottle 1 to Choti Mami
      {
        id: '50db3849-23cc-4a86-a875-95cc6679a590',
        Date: '02/09/2026',
        FromAccount: 'Stock',
        ToAccount: 'Lend',
        Category: 'Lend',
        Amount: '131',
        INR: 131,
        Note: 'Lend to Choti mami',
        Description: 'Lent 1 pcs of Dabur amla (1 pcs (bought on 18 Jan 2026 from Flipkart))',
        Tags: '#stock #lent #stock_ref_e970fc35:1'
      },
      // 3. Part 1 installment consumption (Bottle 2)
      {
        id: '86ebb0ce-551a-4ea8-ac76-4cb9518796f6',
        Date: '19/05/2026',
        FromAccount: 'Stock',
        ToAccount: '',
        Category: 'To Home',
        Amount: '26',
        INR: 26,
        Note: 'groceries (1/5)',
        Tags: '#stock #consumed #stock_ref_e970fc35:1'
      },
      // 4. Part 2 financial installment payment (no physical stock ref)
      {
        id: '2cdb1213-8e9c-4551-a9a3-54250cba17a2',
        Date: '19/06/2026',
        FromAccount: 'Stock',
        ToAccount: '',
        Category: 'To Home',
        Amount: '26',
        INR: 26,
        Note: 'groceries (2/5)',
        Tags: '#stock #consumed'
      }
    ];

    const result = reconcileStockLendingDebts({ transactions });
    assert.equal(result.loans.length, 1, 'Only the loan to Choti Mami is tracked as a debt');
    const loan = result.loans[0];
    assert.equal(loan.loanId, '50db3849-23cc-4a86-a875-95cc6679a590');
    assert.equal(loan.borrower, 'Choti mami');
    assert.equal(loan.originalValue, 131);
    assert.equal(loan.outstandingValue, 131);
    assert.equal(result.summary.totalLentValue, 131, 'Installment payments are completely excluded from lending debts');
  });

  // 15. Deterministic results regardless of transaction input ordering
  await suite.test('15. Deterministic results regardless of transaction input ordering (shuffle invariance)', () => {
    const t1 = {
      id: 'loan-1',
      Date: '01/10/2026',
      FromAccount: 'Stock',
      ToAccount: 'Lend',
      Amount: '100',
      INR: 100,
      Note: 'To Ansar',
      Description: 'Lent 1 pcs item',
      Tags: '#stock #lent'
    };
    const t2 = {
      id: 'rep-1',
      Date: '05/10/2026',
      FromAccount: 'Lend',
      ToAccount: 'Cash',
      Amount: '100',
      INR: 100,
      Note: 'From Ansar',
      Tags: '#repayment #stock_debt_ref_loan-1'
    };
    const t3 = {
      id: 'cash-loan',
      Date: '02/10/2026',
      FromAccount: 'Bank',
      ToAccount: 'Lend',
      Amount: '5000',
      INR: 5000,
      Note: 'To Ansar',
      Tags: '#loan'
    };

    const resAscending = reconcileStockLendingDebts({ transactions: [t1, t2, t3] });
    const resDescending = reconcileStockLendingDebts({ transactions: [t3, t2, t1] });
    const resShuffled = reconcileStockLendingDebts({ transactions: [t2, t3, t1] });

    assert.deepEqual(resAscending.summary, resDescending.summary);
    assert.deepEqual(resAscending.summary, resShuffled.summary);
    assert.equal(resAscending.loans[0].status, resDescending.loans[0].status);
    assert.equal(resAscending.loans[0].confirmedRepaidValue, resDescending.loans[0].confirmedRepaidValue);
  });

});
