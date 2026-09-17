import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('square', Path(__file__).resolve().parents[1] / 'migration/prepare_square_customers.py')
square = importlib.util.module_from_spec(spec)
spec.loader.exec_module(square)


class SquareImportTests(unittest.TestCase):
    def test_matching_and_exclusions(self):
        def row(first, last, phone):
            return {'First Name': first, 'Last Name': last, 'Phone Number': phone}
        contacts, counts = square.prepare([
            row('Alex', 'Smith', '+1 (570) 555-0100'),
            row(' alex ', 'smith', '5705550100'),
            row('Alex', 'Smith', '5705550101'),
            row('Jamie', 'Smith', '5705550100'),
            row('Missing', 'Phone', ''),
            row('', '', '5705550100'),
            row('Invalid', 'Phone', '123'),
        ])
        self.assertEqual(len(contacts), 3)
        self.assertEqual(counts, dict(total=7, importable=3, duplicate=1, missing_phone=1, missing_name=1, invalid_phone=1))
        self.assertEqual(contacts[0], ('Alex Smith', '570-555-0100'))

    def test_sql_literal_preserves_apostrophes(self):
        self.assertEqual(square.sql_literal("Pat O'Brien"), "'Pat O''Brien'")


if __name__ == '__main__':
    unittest.main()
