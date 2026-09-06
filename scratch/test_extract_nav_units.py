import re

# Test parsing the concatenated price and units string in CAMS and KFintech
# Example 1: "4,999.75 26.4717188.872SIP Purchase-BSE - Instalment No - 1 - INZ000208032 188.872"
# Example 2: "1,999.90 164.38612.166Systematic Investment New Purchase with SIP (1/1000) 12.166"
# Example 3: "2,999.85 112.758026.604Systematic Investment Existing Folio with SIP (1) 26.604"
# Example 4: "3,999.80 209.62319.081SIP Purchase Instalment No - 1 Online 19.081"
# Example 5: "7,629.62 113.966366.946Purchase 66.946"
# Notice: the cumulative balance at the very end of the line is ALWAYS the new balance!
# Previous balance + units = new balance!
# So units = new balance - previous balance!
# And NAV = net_amt / units!
# Let's verify this mathematically across all lines!

def parse_line_units_nav(line_text, prev_bal, net_amt):
    # The last token in the line is usually the cumulative unit balance
    # e.g. "... 188.872" or "... 1,119.243"
    m_bal = re.search(r'([\d,]+\.\d{3})\s*$', line_text.strip())
    if m_bal:
        new_bal = float(m_bal.group(1).replace(",", ""))
        units = round(new_bal - prev_bal, 3)
        # Verify: units * nav approx net_amt
        # Let's also extract nav from the string
        # NAV is typically before the units or can be derived as net_amt / units
        return units, new_bal
    return None, prev_bal

test_lines = [
    ("19-May-2025 4,999.75 26.4717188.872SIP Purchase-BSE - Instalment No - 1 - INZ000208032 188.872", 0.0, 4999.75),
    ("18-Jun-2025 4,999.75 26.2419190.525SIP Purchase-BSE - Instalment No - 1 - INZ000208032 379.397", 188.872, 4999.75),
    ("18-Jul-2025 4,999.75 26.8229186.399SIP Purchase-BSE - Instalment No - 2/999 - INZ000208032 565.796", 379.397, 4999.75),
    ("18-Mar-2026 1,999.90 164.38612.166Systematic Investment New Purchase with SIP (1/1000) 12.166", 0.0, 1999.90),
    ("20-Apr-2026 1,999.90 171.47211.663Systematic Investment (1) 23.829", 12.166, 1999.90),
    ("21-May-2025 2,999.85 112.758026.604Systematic Investment Existing Folio with SIP (1) 26.604", 0.0, 2999.85),
    ("18-Mar-2026 3,999.80 209.62319.081SIP Purchase Instalment No - 1 Online 19.081", 0.0, 3999.80),
    ("19-Jun-2025 7,629.62 113.966366.946Purchase 66.946", 0.0, 7629.62),
]

for l, pb, na in test_lines:
    u, nb = parse_line_units_nav(l, pb, na)
    nav = na / u if u else 0
    print(f"Prev: {pb:>8.3f} -> New: {nb:>8.3f} | Units: {u:>8.3f} | Calculated NAV: {nav:>8.4f}")
