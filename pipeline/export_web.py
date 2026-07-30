#!/usr/bin/env python3
"""Export the master database as an ENCRYPTED bundle for the dashboard.

Writes data.enc at the repo root: the full dataset encrypted with AES-256-GCM
under a key derived from the access code (PBKDF2-SHA256, 600k iterations).
The browser derives the same key from the code the visitor types and decrypts
in memory — no plaintext database and no password ever ship in the page.

The access code comes from --access-code, the LYNXR_ACCESS_CODE env var, or an
interactive prompt. Rotating the code = re-run this with the new code + push.

Wrong-code detection is free: AES-GCM authentication fails unless the key is
right, so the page needs no separate password check.
"""

import argparse
import base64
import csv
import getpass
import json
import os
import secrets
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

ROOT = Path(__file__).parent.parent
SRC = ROOT / "output" / "master_video_database.csv"
DEST = ROOT / "data.enc"

# OWASP's floor for PBKDF2-HMAC-SHA256 is 600k. We run well above it because the
# ciphertext is public: every iteration multiplies an offline attacker's cost, and
# the honest weak point in this design is the strength of the access code itself.
# Cost is paid once per unlock (~2s in-browser), so a high count is nearly free
# for a legitimate user and expensive for someone grinding a wordlist.
# Measured: ~300ms for 2M in a hardware-accelerated browser, so 8M lands near
# ~1.2s on a laptop and a few seconds on a phone — paid once per unlock. That is
# a 13x attacker cost multiplier over the 600k floor.
PBKDF2_ITERATIONS = 8_000_000

KEEP = [
    "video_id", "creator", "platform", "title", "views", "likes", "comments",
    "engagement_rate", "format_type", "hook_pattern", "niche_category",
    "target_audience", "data_source", "url",
]


def normalize_code(code):
    """Must mirror normalize() in index.html: strip all whitespace, lowercase."""
    return "".join(code.split()).lower()


def load_rows():
    if not SRC.exists():
        raise SystemExit(f"{SRC} not found — run merge_data.py first.")
    with open(SRC, newline="", encoding="utf-8") as f:
        rows = [{k: r.get(k, "") for k in KEEP} for r in csv.DictReader(f)]
    for r in rows:
        for n in ("views", "likes", "comments"):
            try:
                r[n] = int(float(r[n] or 0))
            except ValueError:
                r[n] = 0
    return rows


def encrypt(plaintext: bytes, access_code: str) -> dict:
    salt = secrets.token_bytes(16)
    iv = secrets.token_bytes(12)
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(), length=32, salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    key = kdf.derive(normalize_code(access_code).encode())
    ct = AESGCM(key).encrypt(iv, plaintext, None)  # ciphertext || GCM tag
    b64 = lambda b: base64.b64encode(b).decode()
    return {
        "v": 1,
        "kdf": "PBKDF2-SHA256",
        "iter": PBKDF2_ITERATIONS,
        "salt": b64(salt),
        "iv": b64(iv),
        "ct": b64(ct),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--access-code", default=os.environ.get("LYNXR_ACCESS_CODE"))
    args = ap.parse_args()
    code = args.access_code or getpass.getpass("Access code to encrypt with: ")
    if not normalize_code(code):
        raise SystemExit("Access code is empty.")

    rows = load_rows()
    payload = json.dumps(rows, separators=(",", ":")).encode()
    bundle = encrypt(payload, code)
    DEST.write_text(json.dumps(bundle, separators=(",", ":")))
    print(f"Wrote {DEST} ({len(rows):,} rows encrypted, "
          f"{DEST.stat().st_size / 1024:.0f} KB)")
    print("Rotate the code any time: re-run with --access-code NEWCODE and push.")


if __name__ == "__main__":
    main()
