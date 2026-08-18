-- Lynxr — a GIN index for the discovery prefilter's JSONB containment probes.
-- Dashboard → SQL Editor → New query → paste → Run. Standalone, idempotent.
--
-- WHY THIS EXISTS. worker-discovery-prefilter.md replaced
-- process_adaptations.py's discovery scan (pull every creator's whole `data`
-- blob, filter in Python — 214,900 bytes / 548ms measured live at FIVE
-- creators) with a JSONB containment probe against `data->adaptations`
-- (2 bytes). This index is what keeps that probe cheap on the Postgres side
-- too, once there is enough data for it to matter.
--
-- THE EXPRESSION MUST BE `(data -> 'adaptations')`, not an index on `data`
-- alone. That is exactly what PostgREST emits for a
-- `data->adaptations=cs.…` filter (equivalently, the `or=(data->adaptations
-- .cs."…")` conditions prefilter_url() builds) — an index on the whole `data`
-- column would not be used for this query shape.
--
-- `jsonb_path_ops` RATHER THAN THE DEFAULT `jsonb_ops`, because `@>`
-- (containment) is the only operator these probes ever use, and
-- jsonb_path_ops is smaller and faster for that one operator specifically —
-- it just can't answer key-existence or other jsonb operators, which nothing
-- here needs.
--
-- THIS BUYS NOTHING TODAY AND IS NOT WHY THE PREFILTER IS FAST. At today's
-- row count (five creators) the planner will sequentially scan regardless of
-- whether this index exists — the win already measured (214,900 -> 2 bytes)
-- is entirely on the wire, not in query planning. This is insurance for the
-- point where the ~13 MB of jsonb this table carries per probe becomes the
-- actual bottleneck, somewhere around the low hundreds of creators.
--
-- THE [] CANARY PROBE (PREFILTER_CANARY in process_adaptations.py) cannot
-- use this index — it has no keys to look up, since [] is contained in every
-- array — and will always seq scan. That is fine: it carries `limit=1` and
-- only ever runs on an idle sweep, once, after the real probes come back
-- empty.

create index if not exists lynxr_creators_adaptations_gin
  on public.lynxr_creators
  using gin ((data -> 'adaptations') jsonb_path_ops);
