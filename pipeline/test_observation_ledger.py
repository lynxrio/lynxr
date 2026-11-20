"""Run the independent synthetic ledger suite through the repository's explicit gate."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from research.observation_ledger import test_ledger

if __name__ == "__main__":
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromModule(test_ledger))
    raise SystemExit(not result.wasSuccessful())
