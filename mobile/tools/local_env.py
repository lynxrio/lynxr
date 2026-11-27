"""Run a mobile command with LOCAL publishable config held in memory, never print keys."""

import ipaddress
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]


def local_status():
    p = subprocess.run(
        [
            "npm",
            "exec",
            "--yes",
            "--package",
            "supabase@3.4.0",
            "--",
            "supabase",
            "status",
            "--workdir",
            str(ROOT / "mobile/backend"),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    status = json.loads(p.stdout)
    if urlparse(status["API_URL"]).hostname not in ("127.0.0.1", "localhost"):
        raise RuntimeError("Refusing nonlocal API")
    return status


if __name__ == "__main__":
    status = local_status()
    env = {
        **os.environ,
        "EXPO_PUBLIC_LOCAL_TEST": "1",
        "EXPO_PUBLIC_SUPABASE_URL": status["API_URL"],
        "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY": status["PUBLISHABLE_KEY"],
        "DEVELOPER_DIR": "/Applications/Xcode.app/Contents/Developer",
    }
    command = sys.argv[1:]
    if command[:1] == ["--device-host"]:
        host = command[1]
        address = ipaddress.ip_address(host)
        if address.version != 4 or not (
            host.startswith(("10.", "192.168."))
            or address in ipaddress.ip_network("172.16.0.0/12")
        ):
            raise SystemExit("Device host must be a private IPv4 LAN address.")
        env["EXPO_PUBLIC_SUPABASE_URL"] = "http://" + host + ":54421"
        command = command[2:]
    if not command:
        raise SystemExit("Usage: python3 tools/local_env.py <command> [args]")
    raise SystemExit(
        subprocess.run(command, env=env, cwd=ROOT / "mobile", check=False).returncode
    )
