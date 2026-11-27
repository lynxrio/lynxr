"""Apply checked-in contracts only to the explicitly named local Docker database.
Never reads environment files, links a hosted project, or obtains remote credentials.
"""

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CONTAINER = "supabase_db_lynxr-ios-local"


def sql(statement: str) -> str:
    p = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            CONTAINER,
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-At",
        ],
        input=statement,
        capture_output=True,
        text=True,
        check=False,
    )
    if p.returncode:
        raise RuntimeError(p.stderr)
    return p.stdout.strip()


def bootstrap():
    if sql("select to_regclass('public.lynxr_mobile_jobs') is not null") == "t":
        raise RuntimeError(
            "Already initialized: use a fresh disposable lynxr-ios-local stack."
        )
    for name in [
        "creator_tables.sql",
        "staff_gate.sql",
        "allowance_ledger.sql",
        "billing.sql",
    ]:
        source = (ROOT / "supabase" / name).read_text()
        if name == "staff_gate.sql":
            source = source.split("-- SEED.")[0]
        sql(source)
    sql(
        (
            ROOT
            / "mobile/backend/supabase/migrations/20261127054302_mobile_server_owned_jobs.sql"
        ).read_text()
    )
    print(
        "Local checked-in schema and mobile migration applied; queue remains disabled."
    )


if __name__ == "__main__":
    bootstrap()
