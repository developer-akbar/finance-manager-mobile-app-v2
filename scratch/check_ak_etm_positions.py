import csv
from test_subaccount_update import parse_csv_line

with open("finman_2026-09-02.csv", "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Let's import the position engine and check positions with subAccount == 'Ak ETMoney'
from preview_phase5_mf_normalization import active_schemes
# Let's run position engine in python or node
