"""Explicit offline-runner entry point for the isolated Quant Lab tests."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromNames(["research.quant_lab.test_lab", "research.quant_lab.test_intelligence"])
    raise SystemExit(not unittest.TextTestRunner().run(suite).wasSuccessful())
