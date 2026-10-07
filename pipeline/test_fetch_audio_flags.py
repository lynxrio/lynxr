"""fetch_audio's command line: impersonation is asked for only when it can be served.

Regression test for 2026-10-07. yt-dlp's --impersonate needs curl_cffi; without it yt-dlp
exits before touching the network ("Impersonate target chrome is not available"), so every
audio fetch failed in ~0.2s on the Fly worker — which killed the match lane's only download
path and process_adaptations' audio fallback. No network, no yt-dlp: subprocess.run is
stubbed and the assertions are about the argv fetch_audio builds.
"""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import transcribe as T  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("ok   " if cond else "FAIL ") + name + (" — " + extra if extra else ""))
    if not cond:
        fails.append(name)


def argv_for(can_impersonate, tmp):
    """Run fetch_audio with a stubbed subprocess and return the argv it built."""
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        (Path(tmp) / "x.mp3").write_bytes(b"0")       # pretend the download produced audio
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    real_run, real_can = subprocess.run, T._can_impersonate
    subprocess.run, T._can_impersonate = fake_run, (lambda: can_impersonate)
    try:
        T.fetch_audio("https://www.tiktok.com/@x/video/1", Path(tmp))
    finally:
        subprocess.run, T._can_impersonate = real_run, real_can
    return seen.get("cmd") or []


import tempfile  # noqa: E402

# ONE temp dir for both runs: the -o template carries the directory, so two dirs would make
# the "rest of the command is unchanged" comparison fail for a reason that is not the flag.
with tempfile.TemporaryDirectory() as td:
    with_imp = argv_for(True, td)
    without_imp = argv_for(False, td)

check("curl_cffi present -> --impersonate chrome is sent",
      "--impersonate" in with_imp and with_imp[with_imp.index("--impersonate") + 1] == "chrome")
check("curl_cffi absent -> --impersonate is NOT sent (this is the bug that broke Fly)",
      "--impersonate" not in without_imp and "chrome" not in without_imp)
check("the rest of the command is unchanged either way",
      [a for a in with_imp if a not in ("--impersonate", "chrome")] == without_imp)
for argv in (with_imp, without_imp):
    check("still an audio-only mp3 download", "-x" in argv and "mp3" in argv)

check("_can_impersonate never raises", isinstance(T._can_impersonate(), bool))

print("\n" + ("all checks passed" if not fails else "FAILED: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
