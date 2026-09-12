/**
 * Security Resolution & Canonical Directory (FinMan v2)
 * 
 * Provides resolution of human-readable security names (as shown in Groww / Zerodha)
 * into canonical technical identities:
 * { displayName, symbol, exchange, isin, assetType, isResolved }
 */

export const KNOWN_SECURITIES = [
  // User specified Groww securities
  {
    displayName: 'PC Jeweller',
    symbol: 'PCJEWELLER',
    exchange: 'NSE',
    isin: 'INE785M01010',
    assetType: 'EQUITY',
    aliases: ['PC Jeweller Ltd', 'PC Jewellers', 'PCJEWELLER']
  },
  {
    displayName: 'Vodafone Idea',
    symbol: 'IDEA',
    exchange: 'NSE',
    isin: 'INE669E01016',
    assetType: 'EQUITY',
    aliases: ['VI', 'Idea', 'Vodafone Idea Limited', 'Vodafone Idea Ltd', 'IDEA']
  },
  {
    displayName: 'Syncom Formulations',
    symbol: 'SYNCOMF',
    exchange: 'NSE',
    isin: 'INE312C01025',
    assetType: 'EQUITY',
    aliases: ['Syncom Formulations (India)', 'Syncom Formulations India Ltd', 'SYNCOMF', 'SYNCOM']
  },
  {
    displayName: 'Exicom Tele-Systems',
    symbol: 'EXICOM',
    exchange: 'NSE',
    isin: 'INE777F01019',
    assetType: 'EQUITY',
    aliases: ['Exicom', 'Exicom Tele Systems', 'Exicom Tele Systems Ltd', 'EXICOM']
  },
  {
    displayName: 'Standard Engineering',
    symbol: 'SETL',
    exchange: 'BSE',
    isin: 'INE505C01012',
    assetType: 'EQUITY',
    aliases: ['Standard Engineering Ltd', 'Standard Capital Markets', 'SETL']
  },
  {
    displayName: 'Nippon India ETF Gold BeES',
    symbol: 'GOLDBEES',
    exchange: 'NSE',
    isin: 'INF204KB17I5',
    assetType: 'ETF',
    aliases: ['Gold BeES', 'GOLDBEES', 'Nippon Gold BeES', 'Nippon India Gold ETF']
  },
  {
    displayName: 'SILVERBEES',
    symbol: 'SILVERBEES',
    exchange: 'NSE',
    isin: 'INF204KB1888',
    assetType: 'ETF',
    aliases: ['Silver BeES', 'Nippon India ETF Silver BeES', 'Nippon Silver BeES']
  },
  {
    displayName: 'NIFTYBEES',
    symbol: 'NIFTYBEES',
    exchange: 'NSE',
    isin: 'INF204KB14I2',
    assetType: 'ETF',
    aliases: ['Nifty BeES', 'Nippon India ETF Nifty 50 BeES', 'Nippon Nifty BeES']
  },
  {
    displayName: 'Motilal Oswal Nasdaq 100 ETF',
    symbol: 'MON100',
    exchange: 'NSE',
    isin: 'INF247L01AU4',
    assetType: 'ETF',
    aliases: ['MON100', 'Motilal Nasdaq 100 ETF', 'Nasdaq 100 ETF']
  },
  // Major Indian Equities
  {
    displayName: 'Tata Power',
    symbol: 'TATAPOWER',
    exchange: 'NSE',
    isin: 'INE245A01021',
    assetType: 'EQUITY',
    aliases: ['Tata Power Company', 'Tata Power Ltd', 'TATAPOWER']
  },
  {
    displayName: 'Tata Motors',
    symbol: 'TATAMOTORS',
    exchange: 'NSE',
    isin: 'INE155A01022',
    assetType: 'EQUITY',
    aliases: ['Tata Motors Ltd', 'TATAMOTORS']
  },
  {
    displayName: 'Tata Consultancy Services',
    symbol: 'TCS',
    exchange: 'NSE',
    isin: 'INE467B01029',
    assetType: 'EQUITY',
    aliases: ['TCS', 'Tata Consultancy Services Ltd']
  },
  {
    displayName: 'Reliance Industries',
    symbol: 'RELIANCE',
    exchange: 'NSE',
    isin: 'INE002A01018',
    assetType: 'EQUITY',
    aliases: ['Reliance', 'Reliance Industries Ltd', 'RIL', 'RELIANCE']
  },
  {
    displayName: 'Infosys',
    symbol: 'INFY',
    exchange: 'NSE',
    isin: 'INE009A01021',
    assetType: 'EQUITY',
    aliases: ['Infosys Ltd', 'INFY']
  },
  {
    displayName: 'HDFC Bank',
    symbol: 'HDFCBANK',
    exchange: 'NSE',
    isin: 'INE040A01034',
    assetType: 'EQUITY',
    aliases: ['HDFC Bank Ltd', 'HDFCBANK']
  },
  {
    displayName: 'ICICI Bank',
    symbol: 'ICICIBANK',
    exchange: 'NSE',
    isin: 'INE090A01021',
    assetType: 'EQUITY',
    aliases: ['ICICI Bank Ltd', 'ICICIBANK']
  },
  {
    displayName: 'State Bank of India',
    symbol: 'SBIN',
    exchange: 'NSE',
    isin: 'INE062A01020',
    assetType: 'EQUITY',
    aliases: ['SBI', 'SBIN', 'State Bank']
  },
  {
    displayName: 'ITC',
    symbol: 'ITC',
    exchange: 'NSE',
    isin: 'INE154A01025',
    assetType: 'EQUITY',
    aliases: ['ITC Limited', 'ITC Ltd']
  },
  {
    displayName: 'Bharti Airtel',
    symbol: 'BHARTIARTL',
    exchange: 'NSE',
    isin: 'INE397D01024',
    assetType: 'EQUITY',
    aliases: ['Airtel', 'Bharti Airtel Ltd', 'BHARTIARTL']
  },
  {
    displayName: 'Larsen & Toubro',
    symbol: 'LT',
    exchange: 'NSE',
    isin: 'INE018A01030',
    assetType: 'EQUITY',
    aliases: ['L&T', 'Larsen and Toubro', 'LT']
  },
  {
    displayName: 'Wipro',
    symbol: 'WIPRO',
    exchange: 'NSE',
    isin: 'INE075A01022',
    assetType: 'EQUITY',
    aliases: ['Wipro Ltd', 'WIPRO']
  },
  {
    displayName: 'Zomato',
    symbol: 'ZOMATO',
    exchange: 'NSE',
    isin: 'INE758T01015',
    assetType: 'EQUITY',
    aliases: ['Zomato Ltd', 'ZOMATO']
  },
  {
    displayName: 'Jio Financial Services',
    symbol: 'JIOFIN',
    exchange: 'NSE',
    isin: 'INE414G01012',
    assetType: 'EQUITY',
    aliases: ['Jio Financial', 'JioFin', 'JIOFIN']
  },
  {
    displayName: 'IREDA',
    symbol: 'IREDA',
    exchange: 'NSE',
    isin: 'INE202E01016',
    assetType: 'EQUITY',
    aliases: ['Indian Renewable Energy Development Agency', 'IREDA']
  },
  {
    displayName: 'Suzlon Energy',
    symbol: 'SUZLON',
    exchange: 'NSE',
    isin: 'INE040H01021',
    assetType: 'EQUITY',
    aliases: ['Suzlon', 'Suzlon Energy Ltd', 'SUZLON']
  },
  {
    displayName: 'Tata Steel',
    symbol: 'TATASTEEL',
    exchange: 'NSE',
    isin: 'INE081A01020',
    assetType: 'EQUITY',
    aliases: ['Tata Steel Ltd', 'TATASTEEL']
  },
  {
    displayName: 'Adani Power',
    symbol: 'ADANIPOWER',
    exchange: 'NSE',
    isin: 'INE814H01011',
    assetType: 'EQUITY',
    aliases: ['Adani Power Ltd', 'ADANIPOWER']
  },
  {
    displayName: 'Adani Green Energy',
    symbol: 'ADANIGREEN',
    exchange: 'NSE',
    isin: 'INE364U01010',
    assetType: 'EQUITY',
    aliases: ['Adani Green', 'ADANIGREEN']
  },
  {
    displayName: 'Adani Enterprises',
    symbol: 'ADANIENT',
    exchange: 'NSE',
    isin: 'INE423A01024',
    assetType: 'EQUITY',
    aliases: ['Adani Ent', 'ADANIENT']
  },
  {
    displayName: 'Hindustan Unilever',
    symbol: 'HINDUNILVR',
    exchange: 'NSE',
    isin: 'INE030A01027',
    assetType: 'EQUITY',
    aliases: ['HUL', 'Hindustan Unilever Ltd', 'HINDUNILVR']
  },
  {
    displayName: 'Kotak Mahindra Bank',
    symbol: 'KOTAKBANK',
    exchange: 'NSE',
    isin: 'INE237A01028',
    assetType: 'EQUITY',
    aliases: ['Kotak Bank', 'KOTAKBANK']
  },
  {
    displayName: 'Axis Bank',
    symbol: 'AXISBANK',
    exchange: 'NSE',
    isin: 'INE238A01034',
    assetType: 'EQUITY',
    aliases: ['Axis Bank Ltd', 'AXISBANK']
  },
  {
    displayName: 'Bajaj Finance',
    symbol: 'BAJFINANCE',
    exchange: 'NSE',
    isin: 'INE296A01024',
    assetType: 'EQUITY',
    aliases: ['Bajaj Finance Ltd', 'BAJFINANCE']
  },
  {
    displayName: 'Titan Company',
    symbol: 'TITAN',
    exchange: 'NSE',
    isin: 'INE280A01028',
    assetType: 'EQUITY',
    aliases: ['Titan', 'Titan Company Ltd', 'TITAN']
  },
  {
    displayName: 'Yes Bank',
    symbol: 'YESBANK',
    exchange: 'NSE',
    isin: 'INE528G01035',
    assetType: 'EQUITY',
    aliases: ['Yes Bank Ltd', 'YESBANK']
  },
  {
    displayName: 'IRFC',
    symbol: 'IRFC',
    exchange: 'NSE',
    isin: 'INE053F01010',
    assetType: 'EQUITY',
    aliases: ['Indian Railway Finance Corporation', 'IRFC']
  },
  {
    displayName: 'RVNL',
    symbol: 'RVNL',
    exchange: 'NSE',
    isin: 'INE415G01027',
    assetType: 'EQUITY',
    aliases: ['Rail Vikas Nigam', 'Rail Vikas Nigam Ltd', 'RVNL']
  },
  {
    displayName: 'BEL',
    symbol: 'BEL',
    exchange: 'NSE',
    isin: 'INE263A01024',
    assetType: 'EQUITY',
    aliases: ['Bharat Electronics', 'Bharat Electronics Ltd', 'BEL']
  },
  {
    displayName: 'HAL',
    symbol: 'HAL',
    exchange: 'NSE',
    isin: 'INE066F01012',
    assetType: 'EQUITY',
    aliases: ['Hindustan Aeronautics', 'Hindustan Aeronautics Ltd', 'HAL']
  },
  {
    displayName: 'Mazagon Dock',
    symbol: 'MAZDOCK',
    exchange: 'NSE',
    isin: 'INE249Z01012',
    assetType: 'EQUITY',
    aliases: ['Mazagon Dock Shipbuilders', 'MAZDOCK']
  },
  {
    displayName: 'Cochin Shipyard',
    symbol: 'COCHINSHIP',
    exchange: 'NSE',
    isin: 'INE704P01017',
    assetType: 'EQUITY',
    aliases: ['Cochin Shipyard Ltd', 'COCHINSHIP']
  },
  {
    displayName: 'BHEL',
    symbol: 'BHEL',
    exchange: 'NSE',
    isin: 'INE257A01026',
    assetType: 'EQUITY',
    aliases: ['Bharat Heavy Electricals', 'BHEL']
  },
  // Major Mutual Funds & Index Funds
  {
    displayName: 'Motilal Oswal Nifty Next 50',
    symbol: 'INF247L01AC1',
    exchange: '',
    isin: 'INF247L01AC1',
    assetType: 'MUTUAL_FUND',
    aliases: ['Motilal Nifty Next 50', 'Motilal Oswal Nifty Next 50 Index Fund', 'Father Motilal Nifty Next 50', 'Motilal Oswal Nifty Next 50 Fund', 'Motilal Next 50']
  },
  {
    displayName: 'DSP Nifty Next 50 Index Fund',
    symbol: 'INF740KA1MG9',
    exchange: '',
    isin: 'INF740KA1MG9',
    assetType: 'MUTUAL_FUND',
    aliases: ['DSP Nifty Next 50', 'DSP Nifty Next 50 Index', 'DSP Next 50']
  },
  {
    displayName: 'HDFC Mid-Cap Opportunities Fund',
    symbol: 'INF179K01XQ0',
    exchange: '',
    isin: 'INF179K01XQ0',
    assetType: 'MUTUAL_FUND',
    aliases: ['HDFC Mid-Cap Fund', 'HDFC Mid-Cap', 'HDFC Midcap']
  },
  {
    displayName: 'Mirae Asset Large and Midcap Fund',
    symbol: 'INF769K01BI1',
    exchange: '',
    isin: 'INF769K01BI1',
    assetType: 'MUTUAL_FUND',
    aliases: ['Mirae Asset Large & Midcap', 'Mirae Large and Midcap', 'Mirae Asset Large and Midcap']
  },
  {
    displayName: 'Motilal Oswal Midcap Fund',
    symbol: 'INF247L01445',
    exchange: '',
    isin: 'INF247L01445',
    assetType: 'MUTUAL_FUND',
    aliases: ['Motilal Oswal Midcap', 'Motilal Midcap']
  },
  {
    displayName: 'Nippon India Large Cap Fund',
    symbol: 'INF204K01XI3',
    exchange: '',
    isin: 'INF204K01XI3',
    assetType: 'MUTUAL_FUND',
    aliases: ['Nippon India Large Cap Direct Growth', 'Nippon India Large Cap', 'Nippon Large Cap']
  },
  {
    displayName: 'Nippon India Small Cap Fund',
    symbol: 'INF204K01K15',
    exchange: '',
    isin: 'INF204K01K15',
    assetType: 'MUTUAL_FUND',
    aliases: ['Nippon India Small Cap Direct Growth', 'Nippon India Small Cap', 'Nippon Small Cap']
  },
  {
    displayName: 'Parag Parikh Flexi Cap Fund',
    symbol: 'INF879O01027',
    exchange: '',
    isin: 'INF879O01027',
    assetType: 'MUTUAL_FUND',
    aliases: ['Parag Parikh Flexi Cap', 'PPFAS Flexi Cap', 'Parag Parikh', 'PPFAS']
  },
  {
    displayName: 'Motilal Oswal Large and Midcap Fund',
    symbol: 'INF247L01999',
    exchange: '',
    isin: 'INF247L01999',
    assetType: 'MUTUAL_FUND',
    aliases: ['Motilal Oswal Large & Midcap', 'Motilal Large and Midcap']
  },
  {
    displayName: 'DSP Nifty 50 Equal Weight Index Fund',
    symbol: 'INF740KA1CR7',
    exchange: '',
    isin: 'INF740KA1CR7',
    assetType: 'MUTUAL_FUND',
    aliases: ['DSP Nifty 50 Equal Weight', 'DSP Nifty 50 Equal Weight Index', 'DSP Equal Weight']
  },
  {
    displayName: 'Quant Flexi Cap Fund',
    symbol: 'INF966L01911',
    exchange: '',
    isin: 'INF966L01911',
    assetType: 'MUTUAL_FUND',
    aliases: ['quant Flexi Cap Fund', 'Quant Flexi Cap', 'Quant Flexicap']
  }
];

/**
 * Normalizes a text string for comparison (lowercased, alphanumeric only)
 */
function normalizeText(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Clean canonical security name into short human-readable Note
 */
export function cleanSecurityToNote(securityStr) {
  if (!securityStr) return '';
  let s = String(securityStr).trim();

  // Strip trailing ISIN / Advisor / Registrar / Demat noise in CAS headers
  s = s.replace(/\s*-\s*ISIN\s*:.*$/i, '');
  s = s.replace(/\s*ISIN\s*:.*$/i, '');
  s = s.replace(/\s*\(.*Advisor.*$/i, '');
  s = s.replace(/\s*Registrar\s*:.*$/i, '');
  s = s.replace(/\s*\(\s*(Non\s*-\s*Demat|Non\s*Demat|Demat)\s*\)/gi, '');

  // Strip leading technical code prefix (e.g. "D 842 - ", "D 869 - ", "127 FMGDG - ", "101 ETGPG - ", "166 PEDGG - ")
  s = s.replace(/^[0-9A-Za-z]+(\s+[0-9A-Za-z]+)*\s*[-_]\s*/, (match) => {
    if (/^(Canara|DSP|HDFC|Kotak|Mirae|Motilal|Nippon|Parag|quant|Franklin|Axis|SBI|ICICI|Tata|Aditya|UTI)/i.test(match)) {
      return match;
    }
    return '';
  });

  // Strip redundant AMC prefix if followed by fund name
  s = s.replace(/^(DSP|Canara Robeco|HDFC|Kotak|Mirae Asset|Motilal Oswal|Nippon India|PPFAS|quant|Franklin Templeton)\s+Mutual\s+Fund\s+/i, '');

  // Strip technical plan suffixes
  s = s.replace(/\s*-\s*(Direct|Regular)\s+(Plan|Growth|Option).*$/i, '');
  s = s.replace(/\s*-\s*(Dir|Reg)\s*-\s*Growth.*$/i, '');
  s = s.replace(/\s*-\s*(Direct|Regular)$/i, '');
  s = s.replace(/\s*-\s*Growth.*$/i, '');
  s = s.replace(/\s+Growth(\s+Plan|\s+Option)?/gi, '');
  s = s.replace(/\s+Direct(\s+Plan)?/gi, '');
  s = s.replace(/\s+Plan(\s+Growth)?/gi, '');

  // Clean trailing punctuation / whitespace
  s = s.replace(/[\s\-_,]+$/, '').trim();
  return s;
}

/**
 * Resolves any security string, position, or transaction into its canonical technical identity.
 * Returns { displayName, symbol, exchange, isin, assetType, isResolved }
 */
export function resolveSecurity(target, options = {}) {
  if (!target) {
    return {
      displayName: '',
      symbol: '',
      exchange: '',
      isin: '',
      assetType: 'MUTUAL_FUND',
      isResolved: false
    };
  }

  let inputName = '';
  let inputSymbol = '';
  let inputISIN = '';
  let inputAssetType = '';

  if (typeof target === 'string') {
    inputName = target.trim();
  } else {
    inputName = String(target.displayName || target.note || target.security || target.SecuritySymbol || target.security_symbol || '').trim();
    inputSymbol = String(target.symbol || target.SecuritySymbol || target.security_symbol || '').trim();
    inputISIN = String(target.isin || target.SecurityISIN || target.security_isin || '').trim();
    inputAssetType = String(target.assetType || '').trim();
  }

  // 1. Check ISIN match if provided
  if (inputISIN) {
    const isinUpper = inputISIN.toUpperCase();
    const matched = KNOWN_SECURITIES.find(k => k.isin.toUpperCase() === isinUpper);
    if (matched) {
      return {
        displayName: matched.displayName,
        symbol: matched.symbol,
        exchange: matched.exchange,
        isin: matched.isin,
        assetType: matched.assetType,
        isResolved: true
      };
    }
  }

  // 2. Exact symbol match
  const candidateKeys = [inputSymbol, inputName].filter(Boolean);
  for (const c of candidateKeys) {
    const cUpper = c.toUpperCase().replace(/\.NS$/, '').replace(/\.BO$/, '').trim();
    const matched = KNOWN_SECURITIES.find(k => k.symbol.toUpperCase() === cUpper);
    if (matched) {
      return {
        displayName: matched.displayName,
        symbol: matched.symbol,
        exchange: matched.exchange,
        isin: matched.isin,
        assetType: matched.assetType,
        isResolved: true
      };
    }
  }

  // 3. Name or alias exact / normalized match
  for (const c of candidateKeys) {
    const norm = normalizeText(c);
    if (!norm) continue;

    const matched = KNOWN_SECURITIES.find(k => {
      if (normalizeText(k.displayName) === norm) return true;
      if (normalizeText(k.symbol) === norm) return true;
      return (k.aliases || []).some(a => normalizeText(a) === norm);
    });

    if (matched) {
      return {
        displayName: matched.displayName,
        symbol: matched.symbol,
        exchange: matched.exchange,
        isin: matched.isin,
        assetType: matched.assetType,
        isResolved: true
      };
    }
  }

  // 4. Fuzzy / word containment match for popular multi-word names
  for (const c of candidateKeys) {
    const norm = normalizeText(c);
    if (norm.length >= 4) {
      const matched = KNOWN_SECURITIES.find(k => {
        const kNorm = normalizeText(k.displayName);
        if (norm.startsWith(kNorm) || kNorm.startsWith(norm)) return true;
        return (k.aliases || []).some(a => {
          const aNorm = normalizeText(a);
          return aNorm.length >= 4 && (norm.startsWith(aNorm) || aNorm.startsWith(norm));
        });
      });

      if (matched) {
        return {
          displayName: matched.displayName,
          symbol: matched.symbol,
          exchange: matched.exchange,
          isin: matched.isin,
          assetType: matched.assetType,
          isResolved: true
        };
      }
    }
  }

  // 5. If target starts with INF (Mutual Fund ISIN)
  if (inputISIN.startsWith('INF') || inputName.startsWith('INF')) {
    const isinVal = (inputISIN.startsWith('INF') ? inputISIN : inputName).trim().toUpperCase();
    return {
      displayName: inputName && inputName !== isinVal ? cleanSecurityToNote(inputName) : isinVal,
      symbol: isinVal,
      exchange: '',
      isin: isinVal,
      assetType: 'MUTUAL_FUND',
      isResolved: true
    };
  }

  // 6. Unresolved fallback — DO NOT invent symbols or fake data
  const fallbackAssetType = inputAssetType || (
    inputName.toUpperCase().includes('ETF') || inputName.toUpperCase().includes('BEES') ? 'ETF' :
      inputISIN.startsWith('INF') ? 'MUTUAL_FUND' : 'EQUITY'
  );

  return {
    displayName: cleanSecurityToNote(inputName) || inputName,
    symbol: inputSymbol || (inputName && !inputName.includes(' ') && /^[A-Z0-9]+$/i.test(inputName) ? inputName.toUpperCase() : ''),
    exchange: '',
    isin: inputISIN || '',
    assetType: fallbackAssetType,
    isResolved: false
  };
}

/**
 * Searches and ranks security autocomplete suggestions for input
 */
export function searchSecurities(query, existingSecurities = []) {
  if (!query || !query.trim()) return [];

  const q = query.trim().toLowerCase();
  const qNorm = normalizeText(query);
  const results = [];
  const seenSymbols = new Set();

  // 1. Search known registry
  for (const s of KNOWN_SECURITIES) {
    const matchName = s.displayName.toLowerCase().includes(q);
    const matchSym = s.symbol.toLowerCase().includes(q);
    const matchAlias = (s.aliases || []).some(a => a.toLowerCase().includes(q));

    if (matchName || matchSym || matchAlias) {
      seenSymbols.add(s.symbol.toUpperCase());
      results.push({
        displayName: s.displayName,
        symbol: s.symbol,
        exchange: s.exchange,
        isin: s.isin,
        assetType: s.assetType,
        isResolved: true,
        source: 'REGISTRY'
      });
    }
  }

  // 2. Search existing user securities / transactions
  for (const es of existingSecurities) {
    const sym = String(es.symbol || '').trim();
    const note = String(es.note || es.displayName || '').trim();
    const isin = String(es.isin || '').trim();

    if (!sym && !note) continue;

    const key = (sym || isin || note).toUpperCase();
    if (seenSymbols.has(key)) continue;

    if (
      sym.toLowerCase().includes(q) ||
      note.toLowerCase().includes(q) ||
      isin.toLowerCase().includes(q)
    ) {
      seenSymbols.add(key);
      const res = resolveSecurity(es);
      results.push({
        displayName: note || res.displayName || sym,
        symbol: res.symbol || sym,
        exchange: res.exchange || '',
        isin: res.isin || isin,
        assetType: res.assetType || es.assetType || 'MUTUAL_FUND',
        isResolved: res.isResolved,
        source: 'USER_HISTORY'
      });
    }
  }

  return results.slice(0, 10);
}
