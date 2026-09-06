import csv
import json
import re
from datetime import datetime

CSV_FILE = "finman_2026-09-02.csv"
FAREEDA_CAS_FILE = "scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt"
AMMI_CAS_FILE = "scratch/CAS_Ammi Groww_Liquid_MF.pdf.txt"
PREVIEW_JSON = "scratch/phase5_conversion_preview.json"

MONTHS = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12
}

def parse_cas_date(s):
    p = s.split("-")
    return datetime(int(p[2]), MONTHS[p[1]], int(p[0]))

def parse_finman_date(s):
    p = s.split("/")
    return datetime(int(p[2]), int(p[1]), int(p[0]))

# 1. Parse CAS files into structured schemes and tranches
def parse_cas_file(filepath, label):
    with open(filepath, "r", encoding="utf-8") as f:
        text = f.read()

    lines = text.split("\n")
    schemes = []
    
    cur_folio = ""
    cur_isin = ""
    cur_name = ""
    cur_mode = "NON_DEMAT"
    cur_closing_units = 0.0
    cur_closing_cost = 0.0
    cur_txns = []
    cur_bal = 0.0
    
    for i, line_raw in enumerate(lines):
        line = line_raw.strip()
        
        if "Folio No:" in line:
            cur_folio = line.replace("Folio No:", "").strip()
            
        if "ISIN:" in line:
            m_isin = re.search(r'ISIN:\s*([A-Z0-9]{12})', line)
            if m_isin:
                cur_isin = m_isin.group(1)
            cur_name = line
            for k in range(max(0, i-4), i):
                if any(w in lines[k] for w in ["Fund", "Direct", "Growth", "DSP", "PPFAS", "HDFC", "Motilal", "Mirae", "Nippon", "Quant"]):
                    cur_name = lines[k].strip() + " " + cur_name
            cur_mode = "DEMAT" if "(Demat" in line or "(Demat" in cur_name else "NON_DEMAT"
            cur_txns = []
            cur_bal = 0.0
            
        m_dt = re.match(r'^(\d{2}-[A-Za-z]{3}-\d{4})\s+(.*)$', line)
        if m_dt and cur_isin:
            dt = m_dt.group(1)
            rest = m_dt.group(2).strip()
            if "*** Stamp Duty ***" in rest:
                m_sd = re.search(r'^([\d,\.]+)\s*\*\*\*\s*Stamp Duty', rest)
                if m_sd and cur_txns:
                    cur_txns[-1]["stamp_duty"] = float(m_sd.group(1).replace(",", ""))
            elif "Redemption" in rest:
                # Update running balance
                m_bal = re.search(r'([\d,]+\.\d{3})\s*$', rest)
                if m_bal:
                    cur_bal = float(m_bal.group(1).replace(",", ""))
            elif any(kw in rest for kw in ["Purchase", "Systematic Investment", "Sys. Investment"]):
                # Allotment line
                m_amt = re.match(r'^([\d,]+\.\d{2})\s+(.*)$', rest)
                if m_amt:
                    net_amt = float(m_amt.group(1).replace(",", ""))
                    rem = m_amt.group(2).strip()
                    m_bal = re.search(r'([\d,]+\.\d{3})\s*$', rem)
                    if m_bal:
                        new_bal = float(m_bal.group(1).replace(",", ""))
                        units = round(new_bal - cur_bal, 3)
                        units_str = f"{units:.3f}"
                        m_nav = re.search(r'^([\d\.]+?)' + re.escape(units_str), rem)
                        if m_nav:
                            nav = float(m_nav.group(1))
                        else:
                            nav = round(net_amt / units, 4) if units else 0.0
                            
                        cur_txns.append({
                            "cas_date": dt,
                            "net_amt": net_amt,
                            "stamp_duty": 0.0,
                            "gross_amt": round(net_amt, 2),
                            "units": units,
                            "nav": nav,
                            "balance": new_bal,
                            "rem": rem
                        })
                        cur_bal = new_bal
                        
        if "Closing Unit Balance:" in line:
            m_cl = re.search(r'Closing Unit Balance:\s*([\d,\.]+)\s*Total Cost Value:\s*([\d,\.]+)', line)
            if m_cl:
                cur_closing_units = float(m_cl.group(1).replace(",", ""))
                cur_closing_cost = float(m_cl.group(2).replace(",", ""))
                
            for t in cur_txns:
                t["gross_amt"] = round(t["net_amt"] + t["stamp_duty"], 2)
                
            schemes.append({
                "label": label,
                "folio": cur_folio,
                "isin": cur_isin,
                "name": cur_name,
                "mode": cur_mode,
                "closing_units": cur_closing_units,
                "closing_cost": cur_closing_cost,
                "txns": list(cur_txns)
            })
            cur_txns = []

    return schemes

f_schemes = parse_cas_file(FAREEDA_CAS_FILE, "Fareeda")
a_schemes = parse_cas_file(AMMI_CAS_FILE, "Ammi")

active_schemes = []
for s in f_schemes:
    if s["closing_units"] > 0:
        if s["folio"] == "8470103 / 05" and s["isin"] == "INF740KA1MG9":
            s["txns"] = [t for t in s["txns"] if t["cas_date"] != "12-Jun-2024"]
        active_schemes.append(s)

for s in a_schemes:
    if s["closing_units"] > 0:
        active_schemes.append(s)

assert len(active_schemes) == 19, f"Expected 19 active schemes, found {len(active_schemes)}"

def classify_scheme(s):
    fol = s["folio"]
    isin = s["isin"]
    lbl = s["label"]
    
    if lbl == "Ammi":
        return "Ammi Groww", "PERSONAL"
    elif lbl == "Fareeda":
        if fol == "91055029576 / 0" and isin == "INF247L01AC1":
            return "Fareeda ETMoney", "FATHER_EXTERNAL"
        elif fol in ["91055029576 / 0", "8470103 / 05"]:
            return "Fareeda ETMoney", "MIXED_HOLDING"
        elif fol in ["910118443576 / 0", "910121381854 / 0"] and isin == "INF247L01AC1":
            return "Fareeda Groww", "FATHER_EXTERNAL"
        else:
            return "Fareeda Groww", "PERSONAL"
    return "UNKNOWN", "UNKNOWN"

for s in active_schemes:
    sub, own = classify_scheme(s)
    s["subaccount"] = sub
    s["ownership"] = own
    s["canonical_key"] = f"Liquid Mutual Funds | {sub} | {s['isin']} | {s['folio']} | {s['mode']}"

def get_clean_note(isin, full_name, own):
    if isin == "INF740KA1MG9": return "DSP Nifty Next 50 Index Fund"
    if isin == "INF179K01XQ0": return "HDFC Mid-Cap Fund"
    if isin == "INF769K01BI1": return "Mirae Asset Large and Midcap Fund"
    if isin == "INF247L01445": return "Motilal Oswal Midcap"
    if isin == "INF247L01AC1": return "Motilal Oswal Nifty Next 50" if own != "FATHER_EXTERNAL" else "Father Motilal Nifty Next 50"
    if isin == "INF204K01XI3": return "Nippon India Large Cap Direct Growth"
    if isin == "INF204K01K15": return "Nippon India Small Cap Direct Growth"
    if isin == "INF879O01027": return "Parag Parikh Flexi Cap"
    if isin == "INF247L01999": return "Motilal Oswal Large and Midcap"
    return full_name

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    finman_rows = list(csv.DictReader(f))

for idx, r in enumerate(finman_rows, 1):
    r["_line"] = idx

eligible_rows = []
for r in finman_rows:
    to_a = (r.get("ToAccount") or "").strip()
    from_a = (r.get("FromAccount") or r.get("Account") or "").strip()
    sub = (r.get("SubAccount") or "").strip()
    to_sub = (r.get("ToSubAccount") or "").strip()
    cat = (r.get("Category") or "").strip()
    note = (r.get("Note") or "").strip()
    
    is_mf = to_a == "Liquid Mutual Funds" or from_a == "Liquid Mutual Funds" or cat == "Liquid Mutual Funds" or sub in ["Fareeda Groww", "Fareeda ETMoney", "Ammi Groww"] or to_sub in ["Fareeda Groww", "Fareeda ETMoney", "Ammi Groww"] or "father mutual fund" in note.lower()
    if is_mf:
        eligible_rows.append(r)

conversions = []
matched_finman_ids = set()

for s in active_schemes:
    isin = s["isin"]
    fol = s["folio"]
    mode = s["mode"]
    sub = s["subaccount"]
    own = s["ownership"]
    clean_note = get_clean_note(isin, s["name"], own)
    
    for t in s["txns"]:
        cas_dt = parse_cas_date(t["cas_date"])
        gross_amt = t["gross_amt"]
        
        best_candidate = None
        min_date_diff = 999
        
        for r in eligible_rows:
            rid = r.get("ID")
            if rid in matched_finman_ids:
                continue
                
            r_amt = float(r.get("Amount") or r.get("INR") or 0)
            r_note = (r.get("Note") or "").lower()
            r_desc = (r.get("Description") or "").lower()
            r_sub = (r.get("SubAccount") or r.get("ToSubAccount") or "").strip().lower()
            
            combined_desc = f"{r_note} {r_desc} {r_sub}".replace("et money", "etmoney")
            
            if own == "FATHER_EXTERNAL":
                if "father" not in r_note and "father" not in r_desc:
                    continue
                if r_amt != 0 and r_amt != 600:
                    continue
            else:
                if "father" in r_note or "father" in r_desc:
                    continue
                if abs(r_amt - gross_amt) > 1.0:
                    continue
                    
            scheme_matched = False
            if isin == "INF740KA1MG9":
                scheme_matched = "dsp" in combined_desc and "next" in combined_desc
            elif isin == "INF179K01XQ0":
                scheme_matched = "hdfc" in combined_desc
            elif isin == "INF769K01BI1":
                scheme_matched = "mirae" in combined_desc
            elif isin == "INF247L01445":
                scheme_matched = "motilal" in combined_desc and "mid" in combined_desc
            elif isin == "INF247L01AC1":
                scheme_matched = "father" in combined_desc
            elif isin == "INF204K01XI3":
                scheme_matched = "nippon" in combined_desc and "large" in combined_desc
            elif isin == "INF204K01K15":
                scheme_matched = "nippon" in combined_desc and "small" in combined_desc
            elif isin == "INF879O01027":
                scheme_matched = "parag" in combined_desc or "ppfas" in combined_desc
            elif isin == "INF247L01999":
                scheme_matched = "motilal" in combined_desc and ("large" in combined_desc or r_amt == 50000)
                
            if not scheme_matched:
                continue
                
            if sub == "Ammi Groww" and "ammi" not in combined_desc:
                continue
            if sub == "Fareeda Groww" and "etmoney" in combined_desc and "groww" not in combined_desc:
                continue
            if sub == "Fareeda ETMoney" and "etmoney" not in combined_desc:
                continue

            r_dt = parse_finman_date(r.get("Date"))
            diff_days = abs((r_dt - cas_dt).days)
            if diff_days <= 10 and diff_days < min_date_diff:
                min_date_diff = diff_days
                best_candidate = r
                
        assert best_candidate is not None, f"Failed to match CAS tranche {isin} {fol} on {t['cas_date']}"
        matched_finman_ids.add(best_candidate.get("ID"))
        
        tag_str = f"Ownership:{own}|Folio:{fol.replace(' ', '')}|Mode:{mode}"
        
        conversions.append({
            "SourceFinManTransactionID": best_candidate.get("ID"),
            "SourceFinManLineNumber": best_candidate["_line"],
            "TransactionDate": best_candidate.get("Date"),
            "InvestmentAccount": "Liquid Mutual Funds",
            "SubAccount": sub,
            "SchemeNote": clean_note,
            "SecuritySymbol": s["name"][:70],
            "SecurityISIN": isin,
            "FolioNumber": fol,
            "HoldingMode": mode,
            "CASUnits": t["units"],
            "CASNAV": t["nav"],
            "CASGrossAmount": gross_amt,
            "StampDuty": t["stamp_duty"],
            "NetInvestmentAmount": t["net_amt"],
            "CostBasis": t["net_amt"],
            "TradeValue": t["net_amt"],
            "CashImpact": 0.0,
            "PositionQuantityChange": t["units"],
            "OwnershipTag": own,
            "Tags": tag_str,
            "CanonicalPositionKey": s["canonical_key"],
            "ConversionAction": "CONVERT_TO_BUY"
        })

print(f"\n=======================================================")
print(f"DRY-RUN PREVIEW GENERATED: {len(conversions)} PROPOSED CONVERSIONS")
print(f"=======================================================")

with open(PREVIEW_JSON, "w", encoding="utf-8") as f:
    json.dump(conversions, f, indent=2)

print(f"Machine-readable conversion preview saved to: {PREVIEW_JSON}")

# 2. RUN DRY-RUN VALIDATION GATES (Section 15)
print("\n--- RUNNING DRY-RUN VALIDATION GATES ---")

# Gate 1: Count
assert len(conversions) == 111, f"Expected 111 conversions, got {len(conversions)}"
print("GATE 1 [COUNT]: PASS (111 / 111 tranches mapped)")

# Gate 2: Mapping
schemes_in_conv = set(c["CanonicalPositionKey"] for c in conversions)
assert len(schemes_in_conv) == 19, f"Expected 19 canonical keys, got {len(schemes_in_conv)}"
print("GATE 2 [19/19 SCHEMES]: PASS (All 19 active canonical positions represented)")

# Gate 3: Ownership totals
fg_personal = sum(c["CASGrossAmount"] for c in conversions if c["SubAccount"] == "Fareeda Groww" and c["OwnershipTag"] == "PERSONAL")
fg_father = sum(c["CASGrossAmount"] for c in conversions if c["SubAccount"] == "Fareeda Groww" and c["OwnershipTag"] == "FATHER_EXTERNAL")
fetm_mixed = sum(c["CASGrossAmount"] for c in conversions if c["SubAccount"] == "Fareeda ETMoney" and c["OwnershipTag"] == "MIXED_HOLDING")
fetm_father = sum(c["CASGrossAmount"] for c in conversions if c["SubAccount"] == "Fareeda ETMoney" and c["OwnershipTag"] == "FATHER_EXTERNAL")
ammi_total = sum(c["CASGrossAmount"] for c in conversions if c["SubAccount"] == "Ammi Groww")

assert fg_personal == 315000.0, f"FG Personal mismatch: {fg_personal}"
assert fg_father == 9600.0, f"FG Father mismatch: {fg_father}"
assert fetm_mixed == 100000.0, f"FETM Mixed mismatch: {fetm_mixed}"
assert fetm_father == 3600.0, f"FETM Father mismatch: {fetm_father}"
assert ammi_total == 259500.0, f"Ammi mismatch: {ammi_total}"
print("GATE 3 [AMOUNTS]: PASS (All amounts match exact targets)")

# Gate 4: Units Reconciliation per scheme
print("\nGATE 4 [UNITS RECONCILIATION]:")
for s in active_schemes:
    key = s["canonical_key"]
    conv_units = round(sum(c["CASUnits"] for c in conversions if c["CanonicalPositionKey"] == key), 3)
    cas_units = s["closing_units"]
    diff = round(conv_units - cas_units, 3)
    print(f"  {s['subaccount'][:12]:<12} | {s['mode']:<9} | {s['folio']:<18} | {s['isin']} | Conv: {conv_units:>9.3f} | CAS: {cas_units:>9.3f} | Diff: {diff:>6.3f}")
    assert diff == 0.0, f"Unit mismatch for {key}: conv={conv_units}, cas={cas_units}, diff={diff}"
print("GATE 4 [UNITS RECONCILIATION]: PASS (19/19 schemes have ZERO unit difference!)")

# Gate 5: Protected records
protected_lines = [12110, 12411, 8529, 7931, 8157, 8158, 7894, 7247]
conv_lines = set(c["SourceFinManLineNumber"] for c in conversions)
for pl in protected_lines:
    assert pl not in conv_lines, f"Protected line {pl} was included in proposed conversions!"
print("GATE 5 [PROTECTED RECORDS]: PASS (All 8 protected lines completely untouched)")

# Gate 6: SBI RD Line 12110
assert 12110 not in conv_lines, "SBI RD line 12110 touched!"
print("GATE 6 [SBI RD]: PASS (Line 12110 untouched)")

# Gate 7: No duplicate conversions
assert len(matched_finman_ids) == len(conversions), "Duplicate FinMan transactions matched!"
print("GATE 7 [DUPLICATE PREVENTION]: PASS (All 111 FinMan IDs are unique)")

print("\n=======================================================")
print("ALL DRY-RUN VALIDATION GATES PASSED WITH 100% SUCCESS!")
print("=======================================================")
