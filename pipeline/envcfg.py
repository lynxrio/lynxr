"""The one place a secret or config value gets read out of the environment.

INCIDENT: every `.github/workflows/adaptations.yml` run failed from run #168
(2026-08-18 07:57Z) onward. The `SUPABASE_SERVICE_ROLE_KEY` repo secret was
saved with a trailing newline, and `http.client.putheader` refuses any header
value containing one — so `sb()` died with `ValueError: Invalid header value
b'***\\n'` on the first Supabase call of every pass. `pipeline/watchdog.py
--once` died on the identical error in the same loop and then printed
"no breaches" — a false all-clear.

`.env` was NEVER at fault: every `load_env()` copy in this repo already
`.strip()`s the value it parses out of the file. The newline arrived through
`os.environ`, from GitHub, which no `.env` parser touches — hence a
chokepoint at the env-read site itself, plus one in-place sanitize of
`os.environ` for readers this repo does not own (see `sanitize_environ`).

Side-effect-free by construction: no `logging.basicConfig`, no `mkdir`, no
work at import. That is the property that lets `process_adaptations.py`,
`watchdog.py` and `worker.py` all import this module, which they cannot do to
each other (see the `NEVER import process_adaptations here` comment at
`pipeline/watchdog.py:86`).
"""

import os

# Every name this repo reads out of the environment. Anything holding a
# secret, plus the config knobs that end up inside an API request body or a
# model id — a trailing newline breaks those quietly rather than loudly.
SANITIZED = (
    "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "APIFY_API_TOKEN",
    "NTFY_TOPIC", "NTFY_SERVER",
    "WHISPER_MODEL", "WHISPER_CONCURRENCY",
    "TAG_MODEL", "TAG_EFFORT", "ANTHROPIC_MAX_RETRIES", "FUSE_FORMAT_ADAPT",
    "REUSE_SOURCES", "WORKER_PEERS", "WORKER_CONCURRENCY",
    "SCRIPT_CAP", "DAILY_SCRIPT_CAP", "DIGEST_HOUR_UTC",
    "VIEWS_MAX_AGE_H", "VIEWS_PER_PASS", "VIEWS_PAID_MAX_AGE_H", "VIEWS_PAID_RETRY_H", "VIEWS_PAID_RETRY_WINDOW_H", "VIEWS_PAID_TAPER_AFTER_H", "VIEWS_PAID_TAPER_MAX_AGE_H",
    "APIFY_RUN_TIMEOUT_S", "APIFY_MAX_CHARGE_USD", "APIFY_MAX_MONTHLY_USD",
    "APIFY_BUDGET_TTL_S",
    "AGENCY_LANE", "AGENCY_POLL_S", "AGENCY_PER_PASS",
    "TRACK_TT", "TRACK_VERIFY_PER_PASS", "TRACK_TT_VERIFY_TRIES", "TRACK_IG_VERIFY_TRIES", "TRACK_TT_AUTOCHECK_DAYS",
    "TRACK_APIFY_RESERVE", "TRACK_IG_FREE_STOP", "TRACK_IG_PRO_STOP", "TRACK_APIFY_MAX_CHARGE_USD", "TRACK_POSTS", "TRACK_POLL_S", "TRACK_FAST_S",
    "TRACK_SCAN_PER_PASS", "TRACK_MEASURE_PER_PASS", "TRACK_FOLLOW_PER_PASS", "TRACK_TT_SCAN_H", "TRACK_IG_SCAN_H",
    "TRACK_TT_LIST_LIMIT", "TRACK_IG_LIST_LIMIT", "TRACK_BACKFILL_DAYS", "TRACK_CHECKPOINTS", "TRACK_MEASURE_RETRY_H",
    "TRACK_MEASURE_MAX_FAILS", "TRACK_FOLLOWERS", "TRACK_IG_FOLLOWERS", "TRACK_FOLLOW_RETRY_H",
    "TRACK_MATCH", "TRACK_MATCH_WRITE", "TRACK_MATCH_PER_PASS", "TRACK_MATCH_BUDGET_S", "TRACK_MATCH_MAX_SEC",
    "TRACK_MATCH_RETRY_H", "TRACK_MATCH_MAX_FAILS",
    "MATCH_AUTO_MIN", "MATCH_MARGIN", "MATCH_CONTAIN_MIN", "MATCH_CONTAIN_STRONG", "MATCH_AUTO_DAYS", "MATCH_LOG_MIN",
    "MATCH_WINDOW_DAYS", "MATCH_PER_SCRIPT",
    "MATCH_SPARSE_SCRIPT_WORDS", "MATCH_SPARSE_POST_WORDS", "MATCH_SPARSE_DAYS",
    "BRAIN_VOICE", "BRAIN_VOICE_MODEL", "BRAIN_VOICE_DAYS", "BRAIN_PER_PASS", "BRAIN_EVERY_H", "BRAIN_SCAN_LIMIT",
    "BRAIN_WINDOW_DAYS", "BRAIN_DAY", "BRAIN_DAY_TOL", "BRAIN_MIN_POSTS", "BRAIN_SAMPLES", "BRAIN_SAMPLE_CHARS",
    "BRAIN_GROUP_HIGH", "BRAIN_GROUP_LOW", "BRAIN_GROUP_MIN",
)


def clean(value):
    """"" for None, otherwise str(value).strip()."""
    if value is None:
        return ""
    return str(value).strip()


def first(*values, default=""):
    """The first argument that is non-empty after clean(). Pass the
    arguments in the order the call site already used, so this never
    silently changes which source of a value wins."""
    for v in values:
        c = clean(v)
        if c:
            return c
    return default


def get(name, default=""):
    """One environment variable, cleaned. For module-level constants, which
    are evaluated at import and so cannot rely on sanitize_environ()."""
    return first(os.environ.get(name), default=default)


def secret(label, *values, default=""):
    """first(), plus a hard refusal of whitespace left INSIDE the value.
    .strip() cannot fix an embedded newline, and http.client.putheader
    rejects it 300 lines later with a message that names no variable.
    Raises ValueError naming `label` and NEVER the value."""
    v = first(*values, default=default)
    if v and any(c.isspace() for c in v):
        raise ValueError(
            f"{label}: value contains embedded whitespace (e.g. an internal "
            "newline) even after stripping leading/trailing whitespace — "
            "re-save the secret without it")
    return v


def sanitize_environ(names=SANITIZED):
    """Strip os.environ in place for `names`. Returns the list of names it
    changed (never the values) so a caller can log that it happened.

    This is the only fix that reaches readers this repo does not own:
    analyze_visuals.py:223, retag_others.py:133, retag_with_audio.py:254,
    tag_extra_dims.py:301 and tag_videos.py:186 all construct
    anthropic.Anthropic() with no api_key, so the SDK reads
    ANTHROPIC_API_KEY out of os.environ itself and no wrapper at our own
    call sites can clean it."""
    changed = []
    for name in names:
        if name in os.environ:
            current = os.environ[name]
            cleaned = clean(current)
            if cleaned != current:
                os.environ[name] = cleaned
                changed.append(name)
    return changed
