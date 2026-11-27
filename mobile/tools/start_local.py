"""Start only the isolated local stack without putting LOCAL keys in CI logs."""

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
command = [
    "npm",
    "exec",
    "--yes",
    "--package",
    "supabase@3.4.0",
    "--",
    "supabase",
    "start",
    "--workdir",
    str(ROOT / "mobile/backend"),
    "--exclude",
    "realtime,storage-api,imgproxy,studio,postgres-meta,edge-runtime,logflare,vector,supavisor",
]
p = subprocess.run(command, capture_output=True, text=True, check=False)
if p.returncode:
    raise SystemExit(
        f"Local stack startup failed (exit {p.returncode}). Check Docker and CLI compatibility locally; command output is suppressed to avoid logging local keys."
    )
print("Isolated local Supabase started. Credentials suppressed.")
