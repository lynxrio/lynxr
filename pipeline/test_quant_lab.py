"""Explicit offline-runner entry point for the isolated Quant Lab tests."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromName("research.quant_lab.test_lab")
    raise SystemExit(not unittest.TextTestRunner().run(suite).wasSuccessful())
