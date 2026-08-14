-- ---------------------------------------------------------------------------
-- WAIT LIST — UNSUBSCRIBES (2026-08-17)
-- Dashboard -> SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- ---------------------------------------------------------------------------
-- The privacy page promises "every email carries a one-click unsubscribe, and
-- unsubscribing stops all of it". The ESP honours that inside its own audience
-- — Resend suppresses a contact who unsubscribes and will not send to them
-- again, even if you re-import the same CSV.
--
-- What the ESP CANNOT do is tell this database. Without the column below,
-- lynxr_waitlist still lists that person as a subscriber, and the first export
-- into a different tool — a new ESP, a script, a spreadsheet — silently emails
-- someone who opted out. That is the failure this prevents: the promise is made
-- by lynxr, so lynxr has to be able to keep it on its own.
--
-- NULL means subscribed. A timestamp means they left, and when.
alter table public.lynxr_waitlist
  add column if not exists unsubscribed_at timestamptz;

-- Partial index: every send filters on `unsubscribed_at is null`, and the
-- unsubscribed rows are the ones we never want to scan.
create index if not exists lynxr_waitlist_active_idx
  on public.lynxr_waitlist (created_at)
  where unsubscribed_at is null;

-- NO new RLS policy on purpose. anon may still only INSERT (joining the list).
-- Granting anon UPDATE so a browser could unsubscribe itself would let anyone
-- unsubscribe anyone, by typing their address — the ESP's own signed one-click
-- link is the safe version of that, and it is already in every email.
-- Marking someone unsubscribed is done with the service-role key, below.

-- ---------------------------------------------------------------------------
-- WORKING WITH IT
-- ---------------------------------------------------------------------------
-- Who should receive the next send (this is what you export):
--     select email from public.lynxr_waitlist
--      where unsubscribed_at is null
--      order by created_at;
--
-- Mark someone as unsubscribed, after the ESP reports it:
--     update public.lynxr_waitlist
--        set unsubscribed_at = now()
--      where email = 'them@example.com';
--
-- Who has left, and when:
--     select email, unsubscribed_at from public.lynxr_waitlist
--      where unsubscribed_at is not null
--      order by unsubscribed_at desc;
--
-- Rows are kept rather than deleted, deliberately: a deleted row can rejoin the
-- list by accident on the next import, whereas a tombstone cannot. If someone
-- asks to be erased entirely (a GDPR request rather than an unsubscribe), then
-- delete the row — that is a different ask and the privacy page answers it
-- separately.
