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
    "VIEWS_MAX_AGE_H", "VIEWS_PER_PASS",
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
