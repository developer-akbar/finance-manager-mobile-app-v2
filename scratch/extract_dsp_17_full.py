import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

DSP_17_IDS = [
    "6e55e5ac-9d2e-47c7-a16e-71c56452c3ee", # 6971: 23000
    "e9b70da8-db53-4ec9-a0a8-56908bd148d1", # 7228: 50000
    "67e2552f-b1b0-4fc5-9819-011fc792bc58", # 7489: 100000
    "ca66768f-b994-4aa2-9ab2-598daf44fb71", # 7751: 50000
    "5aaf60e6-2ece-4dc6-9a0c-deeb97ed982e", # 7946: 10000
    "acd961ec-2be7-4c82-b4bb-59d75e4ae555", # 8213: 10000
    "7ac21162-604a-43c0-a868-e23c28cbdf2c", # 8493: 5000
    "4992f3ec-ec7f-4e8a-abd0-41d5dea65cbb", # 8747: 5000
    "841de93e-0356-4c69-bd89-8aed6c6948bd", # 8981: 5000
    "10d793a1-f4af-41eb-828e-7d41865d3cd2", # 9258: 5000
    "a8952038-e29e-467e-a9f0-5f100ee49fef", # 9493: 5000
    "b8d23e14-8e24-40d3-bf7d-905ddc848562", # 9778: 5000
    "ca401ed4-50f4-45a6-84aa-2be06b722427", # 10000: 5000
    "637da1f3-2676-4e23-8596-6934346b58b5", # 10372: 5000
    "7c9fdf01-8788-457c-b2a6-b17ff1ebb310", # 10640: 5000
    "35199c20-83be-4d6b-b3ad-127241c5a308", # 10967: 5000
    "5121808e-3569-49c4-b5dd-135065db76ca", # 11300: 5000
]

found = []
for idx, r in enumerate(rows, 1):
    rid = r.get("ID")
    if rid in DSP_17_IDS:
        r["_line"] = idx
        found.append(r)

# Sort chronologically by date
found.sort(key=lambda r: (r.get("Date", "").split("/")[::-1]))

total_amt = 0
for f in found:
    amt = float(f.get("Amount") or 0)
    total_amt += amt
    sec = f.get("SecurityName") or f.get("Security") or f.get("Note") or ""
    isin = f.get("SecurityISIN") or f.get("ISIN") or "INF740KA1CR7"
    qty = f.get("Quantity") or "N/A (Cash Transfer)"
    sub = f.get("SubAccount") or "Fareeda Groww"
    to_sub = f.get("ToSubAccount") or "Fareeda Groww"
    print(f"Line {f['_line']:5d} | ID: {f.get('ID')} | Date: {f.get('Date')} | Security: {sec:<20} | ISIN: {isin} | Amt: Rs. {amt:>9.2f} | Qty: {qty} | Sub: '{sub}' | ToSub: '{to_sub}'")

print(f"\nTotal Amount: Rs. {total_amt:,.2f}")
