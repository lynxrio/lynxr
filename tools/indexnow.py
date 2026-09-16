"""Tell Bing (and every other IndexNow engine) that lynxr.io's pages changed.

Run this AFTER a push has deployed, never before: the engines fetch the pages
right away, and the key file must already be live at
https://lynxr.io/<key>.txt or the submission is rejected.

    ./venv/bin/python tools/indexnow.py            # every URL in sitemap.xml
    ./venv/bin/python tools/indexnow.py /about/    # just these paths

Why it matters for lynxr: Bing's index is what ChatGPT search, Copilot and
DuckDuckGo read, so this is the fastest route into AI answers. Google does
not use IndexNow; for Google, submit sitemap.xml in Search Console instead.

It sends nothing but public URLs and the public key. Standard library only.
"""
import json
import re
import ssl
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOST = "lynxr.io"
# Cloudflare in front of lynxr.io answers 403 to Python's default "Python-urllib"
# user agent (measured 2026-09-16; curl, bingbot and this string all get 200), so
# the key-file check announces itself honestly instead.
UA = "lynxr-indexnow/1.0 (+https://lynxr.io/)"


def tls_context():
    """The python.org macOS build ships without root certificates until its
    "Install Certificates" script is run, and every HTTPS call then fails with
    CERTIFICATE_VERIFY_FAILED. Verification stays ON: fall back to the system
    bundle macOS already has, rather than turning checks off."""
    ctx = ssl.create_default_context()
    if not ctx.get_ca_certs() and Path("/etc/ssl/cert.pem").exists():
        ctx.load_verify_locations("/etc/ssl/cert.pem")
    return ctx


def main():
    keys = [p.stem for p in ROOT.glob("*.txt") if re.fullmatch(r"[0-9a-f]{32}", p.stem)]
    if len(keys) != 1:
        sys.exit(f"expected exactly one IndexNow key file in the repo root, found {len(keys)}")
    key = keys[0]

    if len(sys.argv) > 1:
        urls = [f"https://{HOST}/{a.lstrip('/')}" for a in sys.argv[1:]]
    else:
        urls = re.findall(r"<loc>([^<]+)</loc>", (ROOT / "sitemap.xml").read_text())

    ctx = tls_context()
    probe = urllib.request.Request(f"https://{HOST}/{key}.txt", headers={"User-Agent": UA})
    live = urllib.request.urlopen(probe, timeout=15, context=ctx).read().decode().strip()
    if live != key:
        sys.exit("the key file is not live yet: push and wait for the deploy, then run this again")

    body = json.dumps({"host": HOST, "key": key, "keyLocation": f"https://{HOST}/{key}.txt", "urlList": urls}).encode()
    req = urllib.request.Request("https://api.indexnow.org/indexnow", data=body,
                                 headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
        print(f"IndexNow answered {r.status} for {len(urls)} URL(s)")  # 200 or 202 = accepted


if __name__ == "__main__":
    main()
