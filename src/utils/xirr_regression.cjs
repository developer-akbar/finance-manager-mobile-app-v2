const { computePositionXIRR, computePortfolioXIRR } = require('./portfolioAggregation.js');

function runXirrRegressionTests() {
  console.log('=== XIRR REGRESSION TEST SUITE ===');

  // Test 1: Dated cash flow XIRR calculation
  const mockTataPowerPosition = {
    symbol: 'TATAPOWER',
    status: 'ACTIVE',
    txns: [
      { date: '15/04/2024', action: 'BUY', units: 10, unitPrice: 370, tradeValue: 3700 }
    ],
    valuation: {
      isValued: true,
      currentValue: 3680,
      asOf: '04-09-2026'
    }
  };

  const tatapowerXirr = computePositionXIRR(mockTataPowerPosition);
  console.log('TATAPOWER XIRR:', tatapowerXirr !== null ? tatapowerXirr.toFixed(2) + '%' : 'FAILED');
  if (tatapowerXirr === null) {
    throw new Error('TATAPOWER position XIRR failed');
  }

  // Test 2: Portfolio level dated cash flow XIRR calculation
  const mockPortfolioPositions = [
    mockTataPowerPosition,
    {
      symbol: 'WIPRO',
      status: 'ACTIVE',
      txns: [
        { date: '10/01/2024', action: 'BUY', units: 20, unitPrice: 450, tradeValue: 9000 }
      ],
      valuation: {
        isValued: true,
        currentValue: 9800,
        asOf: '04-09-2026'
      }
    }
  ];

  const mockProvider = {
    getValuation: (pos) => pos.valuation
  };

  const portfolioXirr = computePortfolioXIRR(mockPortfolioPositions, mockProvider);
  console.log('Portfolio XIRR:', portfolioXirr !== null ? portfolioXirr.toFixed(2) + '%' : 'FAILED');
  if (portfolioXirr === null) {
    throw new Error('Portfolio level XIRR failed');
  }

  console.log('✅ ALL XIRR REGRESSION TESTS PASSED CLEANLY!');
}

runXirrRegressionTests();
