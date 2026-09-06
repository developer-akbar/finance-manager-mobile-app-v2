# Check exact math of 110 vs 111
personal_groww = {
    "DSP Next 50 Non-Demat": 11,
    "DSP Next 50 Demat": 5,
    "HDFC Mid-Cap": 6,
    "Mirae Large & Midcap": 6,
    "Motilal Midcap": 10,
    "Nippon Large Cap": 10,
    "Nippon Small Cap": 10,
    "PPFAS Non-Demat": 11,
    "PPFAS Demat": 5,
}

father_groww = {
    "Motilal Next 50 Non-Demat": 1,
    "Motilal Next 50 Demat": 15
}

etmoney = {
    "DSP Next 50 Reinvestment": 1,
    "Motilal Midcap Reinvestment": 1,
    "Father Motilal Next 50": 6
}

ammi = {
    "Motilal Midcap Demat (CB 7)": 1,
    "Motilal Midcap Non-Demat (Initial Rs. 500)": 1,
    "Motilal Midcap Non-Demat (CB 1-6)": 6,
    "Motilal Large & Midcap": 3,
    "Nippon Large Cap": 1,
    "PPFAS": 1
}

print("Fareeda Groww Personal:", sum(personal_groww.values()))
print("Fareeda Groww Father:", sum(father_groww.values()))
print("Fareeda ETMoney:", sum(etmoney.values()))
print("Ammi Groww:", sum(ammi.values()))
total_actual = sum(personal_groww.values()) + sum(father_groww.values()) + sum(etmoney.values()) + sum(ammi.values())
print("Total Actual Tranches in CAS:", total_actual)

# Look at Phase 4 Section 1 table:
# It wrote: "Fareeda Groww (Personal): 73 monthly SIP tranches"
# But 11 + 5 + 6 + 6 + 10 + 10 + 10 + 11 + 5 = 74!
# 74 + 16 + 8 + 13 = 111!
# 73 + 16 + 8 + 13 = 110!
