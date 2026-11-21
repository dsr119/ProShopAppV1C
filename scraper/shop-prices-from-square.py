#!/usr/bin/env python3
"""Square catalog export (.xlsx) -> scraper/shop-prices.csv.

Keeps active bags and shoes with a fixed price: category, item name,
variation, price. Quantities and everything else are left out (the repo is
public).

    pip install openpyxl
    python3 scraper/shop-prices-from-square.py ~/Downloads/catalog-....xlsx
"""
import csv
import os
import sys
import warnings

import openpyxl

warnings.filterwarnings('ignore')
CATEGORIES = {'Bowling Bag': 'Bags', 'Bowling Shoe': 'Shoes'}


def main(src, dest):
    wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
    rows = list(wb['Items'].iter_rows(values_only=True))
    # Square puts a blank row above the header.
    head_at = next(i for i, r in enumerate(rows) if r and 'Item Name' in r)
    col = {n: i for i, n in enumerate(rows[head_at])}
    out, skipped = [], 0
    for r in rows[head_at + 1:]:
        if not r or not r[col['Item Name']]:
            continue
        cat = CATEGORIES.get(str(r[col['Categories']] or '').strip())
        if not cat:
            continue
        if str(r[col['Archived']]).upper() == 'Y':
            skipped += 1
            continue
        try:
            price = float(r[col['Price']])
        except (TypeError, ValueError):  # "variable"
            skipped += 1
            continue
        if price <= 0:
            skipped += 1
            continue
        out.append({'category': cat, 'name': str(r[col['Item Name']]).strip(),
                    'variation': str(r[col['Variation Name']] or '').strip(), 'price': f'{price:.2f}'})
    with open(dest, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['category', 'name', 'variation', 'price'])
        w.writeheader()
        w.writerows(out)
    print(f'{len(out)} bag and shoe prices written to {dest} ({skipped} archived or variable skipped)')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1], os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shop-prices.csv'))
