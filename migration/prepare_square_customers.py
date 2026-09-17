"""Create a private SQL import from a Square export. Never commit the output.
Usage: python migration/prepare_square_customers.py export.csv /outside/repo/import.sql
"""
import argparse
import csv
import json
import re
from collections import Counter
from pathlib import Path


def prepare(rows):
    counts = Counter()
    contacts = {}
    for row in rows:
        counts['total'] += 1
        name = ' '.join((row['First Name'] + ' ' + row['Last Name']).split())
        raw = row['Phone Number'].strip()
        if not raw:
            counts['missing_phone'] += 1
            continue
        if not name:
            counts['missing_name'] += 1
            continue
        digits = re.sub(r'\D', '', raw)
        if len(digits) == 11 and digits.startswith('1'):
            digits = digits[1:]
        if len(digits) != 10:
            counts['invalid_phone'] += 1
            continue
        phone = f'{digits[:3]}-{digits[3:6]}-{digits[6:]}'
        key = (name.lower(), phone)
        if key in contacts:
            counts['duplicate'] += 1
            continue
        contacts[key] = (name, phone)
        counts['importable'] += 1
    return list(contacts.values()), dict(counts)


def sql_literal(value):
    return "'" + value.replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv_path', type=Path)
    parser.add_argument('sql_path', type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    if args.sql_path.resolve().is_relative_to(repo):
        parser.error('Save the private customer import outside the repository.')
    with args.csv_path.open(encoding='utf-8-sig', newline='') as source:
        reader = csv.DictReader(source)
        required = {'First Name', 'Last Name', 'Phone Number'}
        if not required.issubset(reader.fieldnames or []):
            parser.error('Expected Square columns: First Name, Last Name, Phone Number.')
        contacts, counts = prepare(reader)
    if not contacts:
        parser.error('No valid named contacts with phone numbers to import.')
    schema = Path(__file__).with_name('add_customer_directory.sql').read_text()
    values = ',\n'.join('(' + ', '.join(map(sql_literal, contact)) + ')' for contact in contacts)
    sql = ('-- Private customer data: do not upload this file to GitHub.\n'
           '-- Run the entire file in the ProShopAppV1C Supabase SQL Editor.\n'
           '-- Repeat-safe: existing contacts and numbers are never overwritten.\n'
           '-- Import summary: ' + json.dumps(counts, sort_keys=True) + '\n'
           'begin;\nset local standard_conforming_strings = on;\n\n' + schema + '\n'
           'with added as (\n'
           'insert into public.customer_directory (customer_name, phone) values\n' + values + '\n'
           'on conflict do nothing\nreturning id\n)\n'
           'select count(*) as newly_added_contacts from added;\n\ncommit;\n')
    args.sql_path.parent.mkdir(parents=True, exist_ok=True)
    args.sql_path.write_text(sql)
    print(json.dumps(counts, sort_keys=True))


if __name__ == '__main__':
    main()
