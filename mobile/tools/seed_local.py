"""Create disposable local-only Auth accounts. Never contacts hosted Supabase."""

import json
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from local_env import local_status

sys.path.insert(
    0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "backend/tests")
)
from bootstrap_local import sql

# Deliberately public, disposable test credential; valid only on this local stack.
EMAIL = "ios-local@example.invalid"
PASSWORD = "LynxrLocalOnly42!"


def seed(email=EMAIL):
    s = local_status()
    req = Request(
        s["API_URL"] + "/auth/v1/admin/users",
        method="POST",
        data=json.dumps(
            {"email": email, "password": PASSWORD, "email_confirm": True}
        ).encode(),
        headers={
            "apikey": s["SERVICE_ROLE_KEY"],
            "Authorization": "Bearer " + s["SERVICE_ROLE_KEY"],
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(req, timeout=15) as r:
            uid = json.load(r)["id"]
    except HTTPError as e:
        if e.code not in (422,):
            raise RuntimeError("Local account creation failed") from None
        uid = sql(f"select id from auth.users where email='{email}'")
        if not uid:
            raise RuntimeError("Local account lookup failed") from None
    sql(
        f"insert into public.lynxr_creators(id,data) values('{uid}','{{\"name\":\"Local iOS tester\",\"brands\":[],\"adaptations\":[]}}') on conflict(id) do nothing; insert into public.lynxr_allowance(id,granted,note) values('{uid}',50,'Disposable local iOS testing only') on conflict(id) do nothing; update lynxr_mobile_private.settings set enabled=true;"
    )
    print(
        "Disposable local test account ready; local mobile queue enabled. No real model processor is running."
    )


if __name__ == "__main__":
    seed()
    seed("ios-local-b@example.invalid")
