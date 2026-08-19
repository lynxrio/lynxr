"""Proves envcfg.py against the run #168 failure it exists to fix — a
trailing newline on `SUPABASE_SERVICE_ROLE_KEY` that `http.client.putheader`
rejects with `ValueError: Invalid header value b'***\\n'`.

Run with

    ./venv/bin/python pipeline/test_envcfg.py

No network — `putheader_ok` opens an `http.client.HTTPConnection` object but
never calls `.connect()` / `.getresponse()`, so no socket is opened; it only
exercises the header-encoding check `putheader` does before anything is sent.
"""

import http.client
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import envcfg  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    FAILS.append(name) if not ok else None
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


# =============================================================================
# The load-bearing check: reproduce the CI failure offline, using the real
# http.client rather than a re-implementation of its rule.
# =============================================================================

def putheader_ok(v):
    c = http.client.HTTPConnection("example.invalid")
    c.putrequest("GET", "/", skip_host=True, skip_accept_encoding=True)
    try:
        c.putheader("Authorization", v)
        return True
    except ValueError:
        return False


check("the live bug: a header value with a trailing newline is rejected",
      putheader_ok("Bearer sb_secret_xxx\n"), False)
check("envcfg.clean() fixes it: the cleaned value is accepted",
      putheader_ok("Bearer " + envcfg.clean("sb_secret_xxx\n")), True)


# =============================================================================
# clean()
# =============================================================================

check("clean(None) == ''", envcfg.clean(None), "")
check("clean('  x  ') == 'x'", envcfg.clean("  x  "), "x")
check("clean('x\\n') == 'x'", envcfg.clean("x\n"), "x")


# =============================================================================
# first()
# =============================================================================

check("first('', '  x  ', default='d') == 'x'",
      envcfg.first("", "  x  ", default="d"), "x")
check("first(None, '', default='d') == 'd'",
      envcfg.first(None, "", default="d"), "d")
check("first('a', 'b') == 'a' — order is precedence",
      envcfg.first("a", "b"), "a")
check("first() with nothing and no default == ''",
      envcfg.first(), "")


# =============================================================================
# secret()
# =============================================================================

check("secret('K', 'abc\\n') == 'abc' — trailing newline stripped",
      envcfg.secret("K", "abc\n"), "abc")

_raised = None
_msg = ""
try:
    envcfg.secret("K", "ab\ncd")
except ValueError as e:
    _raised = True
    _msg = str(e)
check("secret('K', 'ab\\ncd') raises ValueError", _raised, True)
check("...and the message names the label", "K" in _msg, True)
check("...and the message does NOT contain the value", "ab\ncd" in _msg, False)

check("secret() with nothing and a default returns the default",
      envcfg.secret("K", default="d"), "d")


# =============================================================================
# sanitize_environ()
# =============================================================================

import os  # noqa: E402

_SAVED = {}
for _n in ("SUPABASE_SERVICE_ROLE_KEY", "NTFY_TOPIC"):
    _SAVED[_n] = os.environ.pop(_n, None)

try:
    os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "sb_secret_fake\n"
    os.environ["NTFY_TOPIC"] = "already-clean"
    changed = envcfg.sanitize_environ()
    check("sanitize_environ() strips the dirty value in place",
          os.environ["SUPABASE_SERVICE_ROLE_KEY"], "sb_secret_fake")
    check("sanitize_environ() returns the changed name",
          "SUPABASE_SERVICE_ROLE_KEY" in changed, True)
    check("sanitize_environ() leaves an already-clean value untouched",
          os.environ["NTFY_TOPIC"], "already-clean")
    check("...and does not report it as changed",
          "NTFY_TOPIC" in changed, False)

    # Running it again on the now-clean value changes nothing and reports
    # nothing — the "empty return list" case named in the plan.
    changed_again = envcfg.sanitize_environ()
    check("a second sanitize_environ() pass reports zero changes",
          changed_again, [])
finally:
    for _n, _v in _SAVED.items():
        if _v is None:
            os.environ.pop(_n, None)
        else:
            os.environ[_n] = _v


print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
