import csv

def inspect_csv(filename):
    print(f"=== Inspecting {filename} ===")
    try:
        with open(filename, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            print(f"Total rows: {len(rows)}")
            
            # Count by InvestmentAccount
            inv_accts = {}
            liquid_buys = 0
            liquid_sells = 0
            tax_saver_buys = 0
            tax_saver_sells = 0
            liquid_transfer_out = 0
            
            for r in rows:
                inv_acct = r.get("InvestmentAccount", "") or r.get("investment_account", "")
                inv_type = (r.get("InvestmentTransactionType", "") or r.get("investment_transaction_type", "")).upper()
                acct = r.get("Account", "")
                dest = r.get("ToAccount", "")
                type_raw = r.get("Income/Expense", "")
                
                if inv_acct:
                    inv_accts[inv_acct] = inv_accts.get(inv_acct, 0) + 1
                
                if inv_acct == "Liquid Mutual Funds" or dest == "Liquid Mutual Funds" or acct == "Liquid Mutual Funds":
                    if inv_type == "BUY":
                        liquid_buys += 1
                    elif inv_type == "SELL":
                        liquid_sells += 1
                    elif type_raw == "Transfer-Out":
                        liquid_transfer_out += 1
                        
                if inv_acct == "Mutual Funds Tax Saver" or dest == "Mutual Funds Tax Saver" or acct == "Mutual Funds Tax Saver":
                    if inv_type == "BUY":
                        tax_saver_buys += 1
                    elif inv_type == "SELL":
                        tax_saver_sells += 1
                        
            print(f"InvestmentAccount counts: {inv_accts}")
            print(f"Liquid Mutual Funds: BUYs={liquid_buys}, SELLs={liquid_sells}, Transfer-Out={liquid_transfer_out}")
            print(f"Mutual Funds Tax Saver: BUYs={tax_saver_buys}, SELLs={tax_saver_sells}")
    except Exception as e:
        print(f"Error reading {filename}: {e}")
    print()

inspect_csv("finman_2026-09-01.csv")
inspect_csv("finman_2026-09-02.csv")
inspect_csv("finman_2026-08-31_CAS_All_MF_merged_master_v2.csv")
