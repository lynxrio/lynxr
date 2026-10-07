#!/usr/bin/env python3
"""The offline tests CI runs before a fixer patch may become a pull request (and the model runs before it finishes).

Stdlib only. The list is EXPLICIT: never a glob, so a new flaky test file cannot silently block every fix. The repo
root is the current directory (exit 2 when pipeline/ is not there), which lets the base copy of this script that
fixer.yml keeps in $RUNNER_TEMP run the TREE's tests.

    python3 tools/fixer/run_tests.py
"""

import subprocess
import sys
from pathlib import Path

TESTS = [
    "pipeline/test_ai_retry.py",
    "pipeline/test_allowance.py",
    "pipeline/test_backup.py",
    "pipeline/test_brain_prompt.py",
    "pipeline/test_brief_clips.py",
    "pipeline/test_campaigns.py",
    "pipeline/test_canary.py",
    "pipeline/test_costs.py",
    "pipeline/test_envcfg.py",
    "pipeline/test_fixer.py",
    "pipeline/test_link_checks.py",
    "pipeline/test_prefilter.py",
    "pipeline/test_script_checks.py",
    "pipeline/test_showcase.py",
    "pipeline/test_track_posts.py",
    "pipeline/test_video_limits.py",
    "pipeline/test_views.py",
    "pipeline/test_watchdog.py",
    "tools/fixer/test_gate.py",
]


def main():
    root = Path.cwd()
    if not (root / "pipeline").is_dir():
        print("run from the repo root (no pipeline/ here)", file=sys.stderr)
        return 2
    failed = 0
    for t in TESTS:
        try:
            r = subprocess.run([sys.executable, t], cwd=str(root), capture_output=True, text=True, timeout=300)
            rc, out = r.returncode, (r.stdout or "") + (r.stderr or "")
        except subprocess.TimeoutExpired as e:
            rc, out = 124, str(e)
        if rc == 0:
            print(f"PASS {t}")
        else:
            failed += 1
            print(f"FAIL {t} (rc {rc})")
            print("\n".join(out.splitlines()[-30:]))
    print(f"{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
