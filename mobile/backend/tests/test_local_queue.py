"""Real local Postgres authorization/concurrency checks; no inference or remote access."""

import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from bootstrap_local import sql

A = "10000000-0000-4000-8000-000000000001"
B = "10000000-0000-4000-8000-000000000002"
STAFF = "10000000-0000-4000-8000-000000000003"


def as_user(uid, statement):
    return sql(
        f"begin; set local role authenticated; set local request.jwt.claim.sub='{uid}'; {statement}; commit;"
    )


def submit(uid, jid, code="TestVideo1"):
    return as_user(
        uid,
        f"select public.mobile_submit_job('{jid}','https://www.instagram.com/reel/{code}/?utm_source=test','',true)",
    )


class LocalQueue(unittest.TestCase):
    def setUp(self):
        sql(
            f"delete from auth.users where id in ('{A}','{B}','{STAFF}'); insert into auth.users(id,is_anonymous) values('{A}',false),('{B}',false),('{STAFF}',false); insert into public.lynxr_staff(id) values('{STAFF}'); insert into public.lynxr_creators(id,data) values('{A}','{{\"name\":\"Synthetic A\",\"adaptations\":[]}}'),('{B}','{{\"name\":\"Synthetic B\"}}'); insert into public.lynxr_allowance(id,granted) values('{A}',1),('{B}',1); update lynxr_mobile_private.settings set enabled=true;"
        )

    def tearDown(self):
        sql(
            f"delete from auth.users where id in ('{A}','{B}','{STAFF}'); update lynxr_mobile_private.settings set enabled=false;"
        )

    def test_concurrent_last_credit_and_legacy_writer_isolation(self):
        before = sql(f"select data from public.lynxr_creators where id='{A}'")
        ids = [str(uuid4()), str(uuid4())]

        def attempt(i):
            try:
                submit(A, ids[i], f"TestVideo{i}")
                return True
            except RuntimeError as e:
                self.assertIn("allowance_exhausted", str(e))
                return False

        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(sum(pool.map(attempt, range(2))), 1)
        self.assertEqual(
            sql(
                f"select count(*) from public.lynxr_script_charges where creator_id='{A}'"
            ),
            "1",
        )
        # A simultaneous legacy-style whole-document write cannot delete mobile work.
        sql(
            f"update public.lynxr_creators set data=data||'{{\"webSaved\":true}}' where id='{A}'"
        )
        self.assertEqual(
            sql(
                f"select count(*) from public.lynxr_mobile_jobs where creator_id='{A}'"
            ),
            "1",
        )
        self.assertIn("Synthetic A", before)

    def test_replay_dedup_payload_conflict_and_rollback(self):
        jid = str(uuid4())
        submit(A, jid)
        submit(A, jid)
        alias = str(uuid4())
        self.assertIn(jid, submit(A, alias))
        with self.assertRaisesRegex(RuntimeError, "idempotency_conflict"):
            submit(A, alias, "AliasChanged")
        with self.assertRaisesRegex(RuntimeError, "idempotency_conflict"):
            submit(A, jid, "Changed")
        with self.assertRaisesRegex(RuntimeError, "allowance_exhausted"):
            submit(A, str(uuid4()), "Different")
        self.assertEqual(
            sql(
                f"select count(*) from public.lynxr_mobile_jobs where creator_id='{A}'"
            ),
            "1",
        )

    def test_authorization_and_direct_write_boundaries(self):
        jid = str(uuid4())
        submit(A, jid)
        for uid in [B, STAFF]:
            with self.assertRaises(RuntimeError):
                as_user(uid, f"select public.mobile_retry_job('{jid}')")
        for statement in [
            "select public.mobile_claim_job()",
            "select * from lynxr_mobile_jobs",
            "insert into lynxr_mobile_jobs(id,creator_id,source_url) values(gen_random_uuid(),auth.uid(),'x')",
            "update lynxr_mobile_private.settings set enabled=true",
        ]:
            with self.assertRaisesRegex(RuntimeError, "permission denied"):
                as_user(A, statement)
        with self.assertRaises(RuntimeError):
            sql("set role anon; select public.mobile_snapshot();")
        snapshot = as_user(B, "select public.mobile_snapshot()")
        self.assertNotIn(jid, snapshot)
        with self.assertRaisesRegex(RuntimeError, "creator_required"):
            as_user(STAFF, "select public.mobile_snapshot()")
        with self.assertRaisesRegex(RuntimeError, "unsupported_url"):
            as_user(
                A,
                f"select public.mobile_submit_job('{uuid4()}','https://instagram.com.evil.invalid/reel/x/','',true)",
            )

    def test_worker_failure_refund_retry_fencing_and_completion(self):
        jid = str(uuid4())
        submit(A, jid)
        job = json.loads(sql("select public.mobile_claim_job()"))
        token = job["lease_token"]
        self.assertEqual(
            sql(
                f"select public.mobile_finish_job('{jid}','{uuid4()}',null,'processing_failed')"
            ),
            "f",
        )
        self.assertEqual(
            sql(
                f"select public.mobile_finish_job('{jid}','{token}',null,'source_unavailable')"
            ),
            "t",
        )
        self.assertEqual(
            sql(
                f"select count(*) from public.lynxr_script_charges where creator_id='{A}'"
            ),
            "0",
        )
        as_user(A, f"select public.mobile_retry_job('{jid}')")
        job2 = json.loads(sql("select public.mobile_claim_job()"))
        self.assertNotEqual(token, job2["lease_token"])
        self.assertEqual(
            sql(
                f"select public.mobile_finish_job('{jid}','{token}',null,'processing_failed')"
            ),
            "f",
        )
        payload = '{"source":{"script":{"text":"Stubbed local extraction; no model call."}},"status":"error","id":"evil"}'
        self.assertEqual(
            sql(
                f"select public.mobile_finish_job('{jid}','{job2['lease_token']}','{payload}',null)"
            ),
            "t",
        )
        snapshot = as_user(A, "select public.mobile_snapshot()")
        self.assertIn('"status": "done"', snapshot)
        self.assertNotIn("evil", snapshot)
        self.assertEqual(
            sql(
                f"select count(*) from public.lynxr_script_charges where creator_id='{A}'"
            ),
            "1",
        )

    def test_interruption_and_pending_deletion(self):
        jid = str(uuid4())
        submit(A, jid)
        job = json.loads(sql("select public.mobile_claim_job()"))
        sql(
            f"update public.lynxr_mobile_jobs set lease_until=now()-interval '1 second' where id='{jid}'"
        )
        self.assertEqual(sql("select public.mobile_expire_jobs()"), "1")
        self.assertEqual(
            sql(f"select public.mobile_heartbeat('{jid}','{job['lease_token']}')"), "f"
        )
        as_user(A, "select public.mobile_request_deletion()")
        as_user(A, "select public.mobile_request_deletion()")
        with self.assertRaisesRegex(RuntimeError, "deletion_pending"):
            as_user(A, f"select public.mobile_retry_job('{jid}')")
        self.assertEqual(
            sql(
                f"select count(*) from public.lynxr_mobile_deletions where creator_id='{A}'"
            ),
            "1",
        )

    def test_disabled_and_deleted_or_anonymous_accounts_fail_closed(self):
        sql("update lynxr_mobile_private.settings set enabled=false")
        with self.assertRaisesRegex(RuntimeError, "mobile_unavailable"):
            submit(A, str(uuid4()))
        self.assertEqual(
            sql(
                f"select count(*) from public.lynxr_script_charges where creator_id='{A}'"
            ),
            "0",
        )
        sql("update lynxr_mobile_private.settings set enabled=true")
        sql(f"update auth.users set is_anonymous=true where id='{A}'")
        with self.assertRaisesRegex(RuntimeError, "creator_required"):
            as_user(A, "select public.mobile_snapshot()")
        sql(f"delete from auth.users where id='{B}'")
        with self.assertRaisesRegex(RuntimeError, "creator_required"):
            as_user(B, "select public.mobile_snapshot()")

    def test_account_deletion_cascades_private_mobile_records(self):
        jid = str(uuid4())
        submit(A, jid)
        as_user(
            A, f"select public.mobile_report_script('{jid}','Synthetic test report')"
        )
        as_user(A, "select public.mobile_request_deletion()")
        sql(f"delete from auth.users where id='{A}'")
        for table in [
            "lynxr_mobile_jobs",
            "lynxr_mobile_requests",
            "lynxr_mobile_deletions",
            "lynxr_mobile_reports",
            "lynxr_script_charges",
        ]:
            self.assertEqual(
                sql(f"select count(*) from public.{table} where creator_id='{A}'"), "0"
            )
        with self.assertRaisesRegex(RuntimeError, "creator_required"):
            as_user(A, "select public.mobile_snapshot()")

    def test_brands_are_idempotent_owner_scoped_and_do_not_write_creator_json(self):
        own, foreign, jid = str(uuid4()), str(uuid4()), str(uuid4())
        before = sql(f"select data from public.lynxr_creators where id='{A}'")
        as_user(
            B,
            f"select public.mobile_create_brand('{foreign}','Other brand','Other description')",
        )
        with self.assertRaisesRegex(RuntimeError, "brand_not_found"):
            as_user(
                A,
                f"select public.mobile_submit_job('{jid}','https://instagram.com/reel/BrandFixture/','{foreign}',true)",
            )
        for _ in range(2):
            as_user(
                A,
                f"select public.mobile_create_brand('{own}','Local brand','Local description')",
            )
        with self.assertRaisesRegex(RuntimeError, "idempotency_conflict"):
            as_user(
                A,
                f"select public.mobile_create_brand('{own}','Changed name','Local description')",
            )
        self.assertEqual(
            before, sql(f"select data from public.lynxr_creators where id='{A}'")
        )
        as_user(
            A,
            f"select public.mobile_submit_job('{jid}','https://instagram.com/reel/BrandFixture/','{own}',true)",
        )
        self.assertEqual(
            sql(
                f"select brand_snapshot->>'description' from public.lynxr_mobile_jobs where id='{jid}'"
            ),
            "Local description",
        )
        self.assertEqual(
            sql(
                f"select count(*) from public.lynxr_script_charges where creator_id='{A}'"
            ),
            "1",
        )
        self.assertNotIn("Other brand", as_user(A, "select public.mobile_snapshot()"))

    def test_legacy_and_mobile_charges_share_serialization(self):
        def legacy():
            return sql(
                f"select count(*) from public.charge_scripts('{A}',array['legacy-local-test'])"
            )

        def mobile():
            try:
                submit(A, str(uuid4()))
                return "1"
            except RuntimeError as e:
                self.assertIn("allowance_exhausted", str(e))
                return "0"

        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda f: f(), [legacy, mobile]))
        self.assertEqual(sum(int(x) for x in results), 1)


if __name__ == "__main__":
    unittest.main()
