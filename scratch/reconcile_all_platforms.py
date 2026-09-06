import csv
import json

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Let's see what happens if we properly assign:
# 1. Fareeda ETMoney
# 2. Fareeda Groww
# 3. Ammi Groww
# 4. Ak ETMoney

# Ammi CAS purchases list:
ammi_cas_purchases = [
    ("30/05/2024", 500.0, "Motilal Oswal Midcap"),
    ("19/08/2024", 50000.0, "Motilal Oswal Large and Midcap"),
    ("21/08/2024", 6937.0, "Motilal Oswal Midcap"),
    ("02/09/2024", 2228.0, "Motilal Oswal Midcap"),
    ("23/09/2024", 50000.0, "Motilal Oswal Large and Midcap"),
    ("14/10/2024", 1922.0, "Motilal Oswal Midcap"),
    ("25/11/2024", 3338.0, "Motilal Oswal Midcap"),
    ("25/11/2024", 50000.0, "Motilal Oswal Large and Midcap"),
    ("25/11/2024", 30000.0, "Nippon India Large Cap"),
    ("03/01/2025", 2144.0, "Motilal Oswal Midcap"),
    ("17/02/2025", 43000.0, "Parag Parikh flexi cap"),
    ("28/04/2025", 11801.0, "Motilal Oswal Midcap"),
    ("19/06/2025", 7630.0, "Motilal Oswal Midcap")
]

ammi_cas_total = sum(p[1] for p in ammi_cas_purchases)
print(f"Sum of Ammi CAS active purchases: Rs. {ammi_cas_total:,.2f}")
