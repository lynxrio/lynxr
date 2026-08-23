/* lynxr — creator side.

   A RAIL AND A PANE, not a tabbed page. Brands live in the rail the way
   conversations do in a chat app: pick one and the pane fills with its scripts,
   with a composer pinned at the foot to send the next link. Above them sits
   LIBRARY — every original video the creator has ever sent, kept exactly once
   for the whole account, listing which brands each one turned into a script
   for. A video belongs to the creator, not to a brand, which is why the same
   link scripted for three brands is still one row there.

   Theme is the agency app's, deliberately: same palette, same Share Tech Mono,
   same dot grid, same chip / bp-item / client-editor vocabulary out of the
   shared app.css. Only the furniture is rearranged.

   Deliberately a SEPARATE app from the agency side. Spec §1.1 and §20 require
   that a creator never sees another creator's numbers, the agency dashboard, or
   client business data — so this file never touches lynxr_clients or
   lynxr_videos, and its own table (lynxr_creators) is owner-only at the
   database level, not merely hidden in the UI.

   Naming note: the UI says "brand", the stored key is `brands[]` — the same
   thing the worker reads (brand_digest in process_adaptations.py).

   Scoping note (spec §6.3): the randomized CONTROL arm is an agency-campaign
   mechanic. A self-serve creator came here for a script, so withholding one on
   30% of posts would be a hostile product. Lift for creators is measured the
   §11 fallback way — against their own non-Lynxr posts — and the control arm
   stays on the agency side where Lynx owns the brief slots. */

// ---------- shared helpers (kept in sync with app.js on purpose) ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function safeUrl(u) {
  try {
    const p = new URL(String(u), location.origin);
    return (p.protocol === "http:" || p.protocol === "https:") ? p.href : "";
  } catch { return ""; }
}
/** THE LOADING MARK — the lynxr X split into its four arms, each scaling out of
 *  the centre in clockwise turn (`arm-in` in app.css).
 *
 *  The four arms stop short of the middle: they meet at (12,9), (15,12),
 *  (12,15) and (9,12), which leaves the diamond gap the wordmark has. Do not
 *  "close" that hole — it is the mark, not a rendering slip, and the whole
 *  point of animating this shape instead of a generic spinner is that the thing
 *  spinning is recognisably lynxr.
 *
 *  It exists in one place because it is now used for every long wait: reading a
 *  brand's site, and writing a script from a link. Three hand-copied SVGs would
 *  drift the moment one arm's path changed.
 */
function loaderMark() {
  return `<svg class="loader-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path class="arm a1" fill="currentColor" d="M3 3H6L12 9L9 12L3 6Z"/>
      <path class="arm a2" fill="currentColor" d="M21 3V6L15 12L12 9L18 3Z"/>
      <path class="arm a3" fill="currentColor" d="M15 12L21 18L18 21L12 15Z"/>
      <path class="arm a4" fill="currentColor" d="M12 15L6 21L3 18L9 12Z"/>
    </svg>`;
}
/** Put a status line into a working state: the mark at text size, plus what it
 *  is doing. `text` is ours, never server-supplied — failures use textContent. */
function gateBusy(el, text) {
  el.innerHTML = `<span class="loader inline">${loaderMark()}<span>${escapeHtml(text)}</span></span>`;
}

/* THE PRIVACY POLICY, WITHOUT LEAVING THE PAGE.
   Agreeing to something you have to navigate away to read is a poor bargain —
   and this link sits inside a half-filled signup form, where a new tab means
   losing your place and the back button means losing the form.

   The text is FETCHED from /privacy/ rather than copied in here, so there is
   one policy to keep accurate instead of two that drift apart. Same-origin, and
   connect-src 'self' is already in this page's CSP.

   The <a> keeps its real href throughout: if the fetch fails, or JS never runs,
   the link still works the ordinary way. A modal is an enhancement here, never
   the only route to the text. */
let POLICY_HTML = null;              // fetched once, reused

async function openPolicy() {
  const modal = document.getElementById("policy-modal");
  const body = document.getElementById("policy-body");
  if (!modal || !body) return false;

  modal.hidden = false;
  document.body.classList.add("modal-open");
  if (POLICY_HTML === null) {
    body.innerHTML = `<div class="loader">${loaderMark()}
      <div class="loader-text"><div class="loader-stage">loading the policy…</div></div></div>`;
    try {
      const res = await fetch("/privacy/", { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      // DOMParser does not run scripts, and /privacy/ ships none — but parsing
      // rather than assigning the whole document also means only the prose is
      // taken, not its <head>, favicons or stylesheet link.
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const main = doc.querySelector(".legal");
      if (!main) throw new Error("no .legal");
      // The in-page copy has its own heading and back-links; the modal supplies
      // both, so strip them rather than showing two of each.
      main.querySelectorAll(".legal-back, .legal-foot, h1").forEach((el) => el.remove());
      POLICY_HTML = main.innerHTML;
    } catch {
      POLICY_HTML = null;
      body.innerHTML = `<p class="bp-hint">couldn't load it here —
        <a href="/privacy/" target="_blank" rel="noopener">open the privacy policy</a> instead.</p>`;
      return true;
    }
  }
  body.innerHTML = POLICY_HTML;
  body.scrollTop = 0;
  document.getElementById("policy-close")?.focus();
  return true;
}

function closePolicy() {
  const modal = document.getElementById("policy-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove("modal-open");
}

/** Every /privacy/ link in the app opens the modal instead of navigating.
    Delegated from the document so it covers links that are rendered later —
    the one in Settings is built by renderYou long after this runs. */
document.addEventListener("click", (e) => {
  const a = e.target.closest?.('a[href="/privacy/"]');
  if (!a) return;
  // Let a deliberate new-tab click (cmd/ctrl/middle) behave normally.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  if (openPolicy()) e.preventDefault();
});
document.addEventListener("click", (e) => {
  // Backdrop or close button. The card itself stops here via .modal-card.
  if (e.target.id === "policy-modal" || e.target.closest?.("#policy-close")) closePolicy();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("policy-modal")?.hidden) closePolicy();
});

/** The empty-state demo: a link lands, a script draws itself underneath, on a
 *  loop. Shown where someone has nothing yet and a sentence alone leaves them
 *  guessing what "send a link" actually produces. Decorative — aria-hidden, so
 *  a screen reader gets the wording beside it and not a pile of empty spans. */
function emptyDemo() {
  return `<div class="demo" aria-hidden="true">
      <span class="demo-link"><i class="demo-dot"></i>instagram.com/reel/…</span>
      <span class="demo-arrow">↓</span>
      <span class="demo-card">
        <i class="demo-row r1"></i><i class="demo-row r2"></i><i class="demo-row r3"></i>
      </span>
    </div>`;
}
/** Fit a `.grow` textarea to its text, the way a message composer does.
 *
 *  Height is reset to "auto" before measuring, because scrollHeight can never
 *  report less than the height already set — without the reset the box grows
 *  as you type and then never shrinks back when you delete. A hidden element
 *  measures 0, so leave it alone and re-fit when it is shown.
 */
function autoGrow(el) {
  if (!el || !el.offsetParent) return;
  el.style.height = "auto";
  // An EMPTY field measures its PLACEHOLDER, not its value — and a placeholder
  // wraps to three lines in a narrow pane, so an untouched field opened as a
  // big blank box among one-line inputs. Empty means one row: clearing the
  // inline height hands it back to rows="1".
  if (!el.value) { el.style.height = ""; return; }
  // scrollHeight covers content + padding but NOT the border, while
  // box-sizing: border-box makes the height we set include it. Assigning
  // scrollHeight straight across therefore comes up two pixels short and
  // shaves the bottom off the last line — invisible until a descender lands.
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}
/** Fit now, and on every edit. Blur too: a trim on blur can drop a line. */
function wireGrow(el) {
  if (!el) return;
  autoGrow(el);
  el.addEventListener("input", () => autoGrow(el));
  el.addEventListener("blur", () => autoGrow(el));
}

/** A frame from the source video, for telling one row from another.
 *
 *  The worker uploads it, so it hangs off the adaptation rather than the
 *  library entry — a library row finds it through whichever script was written
 *  from that video. The trash is searched too: a deleted script still knows
 *  what its video looked like, and the library keeps the video regardless.
 *  Returns "" when there is none, and the row renders exactly as it did before.
 */
function coverUrl({ libraryId, canon } = {}) {
  const all = [...(ME.adaptations || []), ...(ME.trash || [])];
  const hit = all.find((x) => (x.source || {}).cover
    && (x.libraryId === libraryId
        || (canon && x.sourceUrl && canonUrl(x.sourceUrl) === canon)));
  return hit ? hit.source.cover : "";
}

/** The thumbnail cell, or nothing at all.
 *  Given `href`, the frame becomes a link to the original video. The ↗ at the
 *  end of the row already goes there, but the thumbnail is the far bigger
 *  target and is the thing that LOOKS like the video, so it is what people
 *  reach for. Inside a <summary> the anchor would also flip the card open
 *  behind the new tab — stopSummaryLinks() is what prevents that, and it
 *  already covers every `summary a`, so this needs no wiring of its own. */
/*  `tile` is the grid card (see .script-grid in app.css) and changes two
 *  things deliberately:
 *    - the cover is NOT wrapped in a link. On a tile the cover is most of the
 *      card, and a 300px-tall anchor to TikTok sitting exactly where the
 *      card's own click target belongs sends people off-site when they meant
 *      to open their own script. The ↗ in the meta row stays, and is given a
 *      real touch target there.
 *    - a missing cover renders a PLACEHOLDER rather than nothing. In a list a
 *      missing thumbnail just closes the gap; in a grid it makes one card a
 *      different height from every other, and Instagram never resolves a
 *      thumbnail at all (no keyless endpoint, and its CDN is not in img-src),
 *      so that is the common case there rather than the rare one. It borrows
 *      .vthumb-none, the same placeholder the agency shelf uses. */
/*  `dur` is the video's length, already formatted ("0:17"), and on a TILE it is
 *  drawn bottom-right ON the cover rather than in the meta row — the place
 *  every video app puts a duration, and the only way the meta row fits on one
 *  line at 320px (see .bp-dur in app.css for the measurement that forced it).
 *  It is still emitted in the meta row too; CSS shows exactly one of the two,
 *  so an opened card reads as it always has and nothing is announced twice.
 *
 *  A tile's frame is therefore a WRAPPER span with the image inside it as
 *  .vthumb — the shape app.js already uses, which is why `.bp-thumb .vthumb`
 *  was already in app.css — instead of .bp-thumb on the <img> itself. The
 *  badge needs a box to be positioned in; an <img> cannot hold one.
 *
 *  `stamp` is the same bottom-right badge slot, but for a trash tile, which
 *  has no duration worth showing and every use for "when did I delete this" —
 *  pass one or the other, never both, or the two badges would sit on top of
 *  each other. */
function thumbHtml(url, label, href, opts = {}) {
  const { tile = false, kind = "", dur = "", stamp = "" } = opts;
  const durBadge = tile && dur
    ? `<span class="bp-dur"><span class="sr-only">Length </span>${escapeHtml(dur)}</span>` : "";
  /* THE SAME BADGE, A DIFFERENT FACT. A trash tile has no use for a duration
     and every use for "when did I delete this", so it passes `stamp` INSTEAD
     of `dur` and the bottom-right badge says that instead. `bp-dur` is kept on
     the class list on purpose: it is the entire visual definition (position,
     ground, mono, and the `[open]` rule that hides it once the card becomes a
     row), and `bp-stamp` is only a semantic hook. Pass one or the other, never
     both — they would sit on top of each other. */
  const stampBadge = tile && stamp
    ? `<span class="bp-dur bp-stamp"><span class="sr-only">Deleted </span>${escapeHtml(stamp)}</span>` : "";
  if (!url) {
    return tile
      ? `<span class="bp-thumb" title="${escapeHtml(label || "")}"
           ><span class="vthumb-none">${escapeHtml(kind || "no cover")}</span>${durBadge}${stampBadge}</span>`
      : "";
  }
  if (tile) {
    return `<span class="bp-thumb" title="${escapeHtml(label || "")}"
      ><img class="vthumb" src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async">${durBadge}${stampBadge}</span>`;
  }
  const img = `<img class="bp-thumb" src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async"
         title="${escapeHtml(label || "")}">`;
  // safeUrl("") is NOT empty — it resolves against location.origin and hands
  // back the current page, so an entry with no sourceUrl would render a
  // thumbnail linking to the app itself. Ask whether there is a url first.
  const safe = href ? safeUrl(href) : "";
  return safe
    ? `<a class="bp-thumb-link" href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer"
         aria-label="Open the original video">${img}</a>`
    : img;
}

/** A STATUS CHIP WITH TWO FACES.
 *
 *  A tile is 138px wide at 320px and its meta row has 116px to hold a status
 *  and the facts beside it, so a twelve-to-nineteen character status wrapped
 *  the row onto a second line — which the owner looked at and rejected
 *  (2026-08-19: "the script status and the other details arent in line with
 *  each other"). Every other lever was measured first: the card is wider now
 *  (180px floor), the chip's padding and the facts' gaps are tighter, and the
 *  duration moved onto the cover. Wording was the last of them, not the first.
 *
 *  BOTH strings are always in the DOM. `.st-full` is the real one — it is what
 *  a list row and an opened card draw, and on a tile it is still there,
 *  visually hidden, so it remains the chip's accessible name. `.st-tile` is
 *  the short face, aria-hidden, drawn only on a closed tile. So the accessible
 *  name never shortens, and nowhere with room for the full wording loses it.
 *
 *    couldn't fetch       -> no video     writing your script -> writing
 *    couldn't write       -> no script    original script     -> original
 *    script ready         -> ready        not scripted        -> not made
 *    writing N scripts    -> writing + N  N scripts ready     -> ready + N
 *    poor fit / no script / writing / ready -> unchanged, they already fit
 *
 *  `no script` is the tile face of BOTH "couldn't write" and the legacy
 *  branded-but-scriptless row, deliberately: to a creator they are the same
 *  sentence, both are red, and the two full wordings are one Tab away in the
 *  accessible name and one click away in the opened card. */
function statusChip(cls, full, short, dot = false, count = 0) {
  const mark = dot ? `<i class="bp-dot"></i>` : "";
  const klass = cls ? `chip ${cls}` : "chip";
  /* THE COUNT RIDES INSIDE THE SHORT FACE, and only there — .st-n is styled in
     the .script-grid block next to .st-tile.
     `full` already states the number in words ("3 scripts ready"), which is
     what the accessible name and an opened card carry. A second copy of it
     alongside that sentence would paint "3 scripts ready · 3" in the list
     layout. Putting the figure INSIDE .st-tile makes that impossible by
     construction rather than by a second visibility rule that can drift from
     the one .st-tile already has.
     Nothing is emitted at 1: one script has no count worth drawing, and the
     tile face is the whole word. */
  const n = count > 1 ? `<i class="st-n">${escapeHtml(String(count))}</i>` : "";
  if (!short || short === full) return `<span class="${klass}">${mark}${escapeHtml(full)}</span>`;
  return `<span class="${klass}">${mark}<span class="st-tile" aria-hidden="true">${escapeHtml(short)}${n}</span>`
    + `<span class="st-full">${escapeHtml(full)}</span></span>`;
}

/** Keep a click on a link inside a <summary> from also toggling the card.
 *  The browser's disclosure toggle is the summary's activation behaviour, so
 *  stopping the event at the anchor is what prevents it — the anchor's own
 *  navigation is a default action and still happens. Covers the ↗ too, which
 *  until now opened the video AND flipped the card open behind it. */
function stopSummaryLinks(root) {
  root.querySelectorAll("summary a").forEach((el) =>
    el.addEventListener("click", (e) => e.stopPropagation()));
}

/** Animate a <details> SHUT as well as open.
 *
 *  A <details> destroys its content the instant `open` is unset, so a closing
 *  animation has nothing left to run on. This holds the card open, plays
 *  `bp-close`, and only then closes it — so the body visibly lifts back up into
 *  the summary it belongs to instead of vanishing.
 *
 *  Under reduced motion it does NOTHING and lets the browser close natively.
 *  That is not politeness: the blanket `animation: none !important` means
 *  `animationend` would never fire, and the card could never be shut again.
 *  The timeout below is the same guard for a dropped event mid-transition.
 */
function wireDisclosureMotion(root) {
  if (!root) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root.querySelectorAll("details.bp-item > summary").forEach((sum) => {
    if (sum.dataset.motion) return;                 // a repaint must not stack handlers
    sum.dataset.motion = "1";
    sum.addEventListener("click", (e) => {
      const card = sum.parentElement;
      if (!card.open) return;                       // opening: CSS bp-open has it
      const body = card.querySelector(":scope > .bp-body");
      if (!body) return;
      e.preventDefault();                           // stop the instant native close
      body.classList.add("bp-closing");
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        body.classList.remove("bp-closing");
        card.open = false;
      };
      body.addEventListener("animationend", finish, { once: true });
      setTimeout(finish, 260);
    });
  });
}
function normalizeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s.includes("://") ? s : "https://" + s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.href;
  } catch { return null; }
}
function canonUrl(raw) {
  try {
    const s = String(raw || "").trim();
    const u = new URL(s.includes("://") ? s : "https://" + s);
    let host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
    let path = u.pathname.replace(/\/+$/, "");
    let key = "";
    if (host === "youtu.be") { key = "?v=" + path.slice(1); host = "youtube.com"; path = "/watch"; }
    else if (host === "youtube.com" && u.searchParams.get("v")) key = "?v=" + u.searchParams.get("v");
    return host + path + key;
  } catch { return String(raw || "").trim().replace(/\/$/, ""); }
}
/* THE FOUR PLATFORMS, and nothing else. yt-dlp will happily fetch a great deal
   more than this, but the rest is not remakeable short-form video — a Netflix
   title, a news article, a Drive file, a podcast page. Every one of those still
   costs a download, a transcription and four model calls before it fails
   somewhere deep in the pipeline, and the creator watches "writing your script"
   for a minute to be told nothing useful. Refusing at the paste box is cheaper
   and is the only place that can say WHY.
   Matched on the HOSTNAME, never as a substring of the whole URL. The old
   /instagram\.com/ test also passed `instagram.com.example.net/x` and
   `evil.com/?from=tiktok.com` — both a plain lookalike and a query string. */
const PLATFORMS = [
  ["TikTok",    ["tiktok.com"]],
  ["Instagram", ["instagram.com"]],
  ["Facebook",  ["facebook.com", "fb.watch", "fb.com"]],
  ["YouTube",   ["youtube.com", "youtu.be"]],
];
const SUPPORTED_LIST = "TikTok, Instagram, Facebook or YouTube";
const hostOf = (raw) => {
  try {
    const s = String(raw || "").trim();
    return new URL(s.includes("://") ? s : "https://" + s).hostname
      .toLowerCase().replace(/^www\./, "");
  } catch { return ""; }
};
/** The platform's display name, or null if the link is not one we accept.
    Subdomains count — vm.tiktok.com, m.facebook.com, music.youtube.com are all
    the platform — but a domain that merely ENDS in one of these words is not. */
function platformOf(raw) {
  const host = hostOf(raw);
  if (!host) return null;
  for (const [label, domains] of PLATFORMS) {
    if (domains.some((d) => host === d || host.endsWith("." + d))) return label;
  }
  return null;
}
// Unsupported links are now refused before anything stores them, so "Link" is
// only ever seen on rows saved before this gate existed.
const platformLabel = (u) => platformOf(u) || "Link";
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const listOf = (xs) => xs.length < 2 ? (xs[0] || "")
  : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function agoLabel(iso) {
  const t = new Date(iso || 0).getTime();
  if (!t) return "";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return String(iso).slice(0, 10);
}

/** Two-click delete. `confirm()` is unusable here — browsers suppress repeated
    dialogs and then return false instantly, so a "confirmation" silently stops
    confirming. Copied from app.js so both apps disarm identically. */
function armDelete(btn, label, onConfirm) {
  let timer = null;
  // Remember the button's FACE, not just its label: some of these are a trash
  // icon, and restoring them with textContent would replace the svg with a
  // word and leave the button permanently wrong after the first disarm.
  const face = btn.innerHTML;
  const disarm = () => {
    clearTimeout(timer);
    btn.classList.remove("armed");
    btn.innerHTML = face;
  };
  /* A double-click used to delete: the first click armed the button and the
     second landed on the armed one milliseconds later, so the safeguard was
     defeated by an ordinary slip of the finger — and this button now sits
     beside Save, which people press often. The armed button therefore ignores
     anything that arrives too quickly to be a considered second press. */
  let armedAt = 0;
  const SETTLE_MS = 450;
  btn.addEventListener("click", (e) => {
    /* BOTH, and stopPropagation alone was not enough — measured 2026-08-23.
       Since the Trash became a .script-grid, the bin lives INSIDE a <summary>,
       and a <details> opens on the click's DEFAULT ACTION, not on a bubbling
       listener. stopPropagation stops listeners; only preventDefault stops the
       disclosure. So arming the bin also flipped the tile open into a
       full-width row and threw "Are you sure?" to the far right of the screen,
       out from under the finger that had just pressed it — on the one control
       in the app that deletes something permanently.
       Safe on every other call site: these are all `type="button"`, which has
       no default action of its own to cancel. */
    e.stopPropagation();
    e.preventDefault();
    if (!btn.classList.contains("armed")) {
      btn.classList.add("armed");
      btn.innerHTML = "Are you sure?";
      btn.title = "This cannot be undone";
      armedAt = performance.now();
      timer = setTimeout(disarm, 5000);
      return;
    }
    if (performance.now() - armedAt < SETTLE_MS) return;   // that was a double-click
    clearTimeout(timer);
    onConfirm();
  });
  btn.addEventListener("blur", disarm);
}

/** Short, speakable, unambiguous code for the creator to say on camera —
    spec §6.2. This is the one attribution path that works today with no
    router and no platform cooperation: the viewer types it, the brand reports
    the redemption, and that conversion is exactly attributed to this video.
    No I/O/0/1 — they get misheard and mistyped. */
function trackCode(brandName) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let tail = "";
  for (let i = 0; i < 4; i++) tail += abc[Math.floor(Math.random() * abc.length)];
  const head = String(brandName || "LYNX").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4) || "LYNX";
  return `${head}${tail}`;
}

// ---------- Supabase ----------
const SB_URL = "https://esakjfogplfszievvabi.supabase.co";
const SB_KEY = "sb_publishable_pTFNX2B94PE_DFLL799w4A_4VcH2xTN";

// Where this app lives, for the links Supabase mails back — confirmation and
// password reset. It moved off /creator.html to an unlisted directory so the
// homepage can be a public marketing page; a stale value here does not fail
// loudly, it just mails people a 404, so it is defined once and used for both.
// Supabase must also allow it: Authentication -> URL Configuration -> Redirect
// URLs needs https://lynxr.io/** or the link is rejected as an open redirect.
const CREATOR_PATH = "/creatorsonly/";
const SB_SESSION_KEY = "lynxr_creator_session";

let SB_TOKEN = null, SB_EMAIL = null, SB_UID = null, SB_REFRESHING = null;
let SYNC_OK = false;
// library[] is every video the creator has sent, ONE entry per video for the
// whole account — a video belongs to them, not to a brand, so the same link
// scripted for three brands is still one row here.
// adaptations[] are the scripts — kept as a flat top-level array because that
// is exactly what the worker iterates; nesting them inside brands would break
// pipeline/process_adaptations.py.
const BLANK_ME = { name: "", niches: [], brands: [], adaptations: [], library: [],
                   trash: [], contactEmail: "", emailOptIn: false };

/** Delete a script the recoverable way: it moves to the trash with a stamp and
 *  the name of the company it was written for, so Settings can offer it back.
 *  Nothing here is free to remake — a delete used to be the one action in the
 *  app that destroyed something you had paid for, behind a single arm. */
function trashAdaptations(pred) {
  const goes = (ME.adaptations || []).filter(pred);
  if (!goes.length) return 0;
  ME.trash = ME.trash || [];
  for (const a of goes) {
    SEEN.delete(a.id);
    ME.trash.unshift({ ...a, deletedAt: new Date().toISOString() });
  }
  ME.adaptations = ME.adaptations.filter((a) => !pred(a));
  return goes.length;
}
let ME = { ...BLANK_ME };

const saveSession = (s) => { try { localStorage.setItem(SB_SESSION_KEY, JSON.stringify(s)); } catch {} };
const loadSession = () => { try { return JSON.parse(localStorage.getItem(SB_SESSION_KEY)); } catch { return null; } };
const clearSession = () => { try { localStorage.removeItem(SB_SESSION_KEY); } catch {} };

function adoptSession(sess, fallbackEmail) {
  SB_TOKEN = sess.access_token;
  SB_EMAIL = sess.user?.email || fallbackEmail || SB_EMAIL;
  SB_UID = sess.user?.id || SB_UID;
  saveSession(sess);
}

async function sbSignIn(email, password) {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error_description || body.msg || "Sign-in failed");
  }
  adoptSession(await res.json(), email);
}

/** Self-serve account creation. Returns "in" when Supabase handed back a
    session (email confirmation is off — go straight into the app) or "confirm"
    when it didn't.

    "confirm" covers two cases on purpose. The honest one is a genuinely new
    address awaiting its confirmation link. The other is an address that already
    has an account: Supabase answers that with a decoy user carrying no
    identities, deliberately, so this endpoint can't be used to find out who has
    an account here. Telling the two apart would undo that, so both get the same
    "check your email" answer. */
async function sbSignUp(email, password, invite) {
  // Tell Supabase where the confirmation link should land, per signup, instead
  // of relying on the project's single Site URL. That setting pointed at
  // localhost, so every confirmation email sent a real user to a page only the
  // developer's laptop could serve. location.origin is whatever host actually
  // served this page, so the link always comes back to the same deployment.
  const back = encodeURIComponent(location.origin + CREATOR_PATH);
  const res = await fetch(`${SB_URL}/auth/v1/signup?redirect_to=${back}`, {
    method: "POST",
    headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    // The invite code rides along as signup metadata. GoTrue writes `data` into
    // raw_user_meta_data BEFORE the gate trigger runs, which is the only way the
    // trigger can see a value that isn't the email or the password.
    body: JSON.stringify(invite ? { email, password, data: { invite } }
                                : { email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.msg || body.message || "Sign-up failed");
  if (body.access_token) { adoptSession(body, email); return "in"; }
  return "confirm";
}

/* SEATS. The invited group is finite and the front door closes by itself —
   see the signup gate in supabase/schema.sql. THE DATABASE IS THE LOCK; this
   is only so a full gate can say so in words.

   WHICH WAY IT FAILS, AND WHY THE TWO HALVES FAIL DIFFERENT WAYS.

   `open` fails OPEN. If the RPC is missing (a database without the migration)
   or the network is down, the page behaves exactly as it did before and the
   trigger still refuses the account — an unreachable check must not lock out a
   creator who is entitled to sign up.

   `invite_required` fails CLOSED, i.e. toward showing the field. Once invites
   are the gate, hiding #invite-wrap on a failed RPC guarantees a refusal the
   creator cannot fix from the screen they are looking at: they submit with no
   code and are told "that email isn't on the invite list", with nowhere to put
   the code sitting in their inbox. Showing an invite field to someone who does
   not need one costs an ignorable input; hiding it from someone who does costs
   the signup. It used to default to false, which meant a single failed fetch
   silently removed the only control that makes signup possible.

   `reached` says which of the two situations produced the answer — `true` is
   "the server told us this", `false` is "we never heard back and these are
   defaults". Nothing renders differently on it today; it exists so a caller
   can never mistake a default for a fact. */
const FULL_MSG = "lynxr is invite-only and full right now — "
  + "join the waitlist at lynxr.io and we'll come to you as we open up.";
let SEATS_OPEN = null;                       // null = not asked yet
let INVITE_REQUIRED = false;

/* The invite that brought them here. An invite link is
   /creatorsonly/?signup=1&e=<email>&c=<code>, so the common path is one click
   and nothing to type; the code field exists for someone who has the mail open
   on their phone and the app on a laptop. */
const INVITE = new URLSearchParams(location.search).get("c") || "";
const INVITED_EMAIL = new URLSearchParams(location.search).get("e") || "";

// What we assume when the RPC does not answer: sign-in stays possible, and the
// invite field is shown. See the block above for why those two go opposite ways.
const GATE_UNKNOWN = { open: true, invite_required: true, reached: false };

async function signupState() {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/signup_state`, {
      method: "POST",
      headers: { apikey: SB_KEY, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) return { ...GATE_UNKNOWN };
    const s = await res.json();
    // A database with no gate row answers null. That is not an answer either —
    // it is the same "we do not know" as a 500, so it takes the same defaults.
    return s && typeof s === "object" ? { ...s, reached: true } : { ...GATE_UNKNOWN };
  } catch { return { ...GATE_UNKNOWN }; }
}

/* Only ever speaks up in create mode: a closed door is no reason to stop
   someone signing in, and saying "we're full" over the sign-in form would read
   as "your account is gone". */
function applySeatState() {
  if (GATE_MODE !== "up") return;
  // The invite field is shown only when the database says invites are the gate,
  // so the same build serves an open signup, a seat-capped one and an
  // invite-only one without a redeploy.
  const wrap = document.getElementById("invite-wrap");
  if (wrap) wrap.hidden = !INVITE_REQUIRED;
  if (SEATS_OPEN === false) {
    document.getElementById("gate-go").disabled = true;
    document.getElementById("err").textContent = FULL_MSG;
  }
}

function refreshSeats() {
  signupState().then((s) => {
    SEATS_OPEN = s.open !== false;
    INVITE_REQUIRED = s.invite_required === true;
    applySeatState();
  });
}

function signupError(raw) {
  const s = String(raw || "");
  /* The seat gate refusing an account. MEASURED against the live project on
     2026-08-12, because the wording here is not obvious: GoTrue passes the
     trigger's own `raise exception` text straight through as `message`, so what
     arrives is "lynxr: signups are closed — all 4 seats are taken" with a 500,
     NOT the generic "Database error saving new user" that a raise inside
     auth.users is usually said to produce. Both are matched — the second as a
     fallback, since which one you get depends on the GoTrue version and it
     costs nothing to cover.

     Only reachable by a page that was already open when the last seat went;
     signup_open() disables the button before this in the normal case. Re-ask
     on the way out so a genuine database fault doesn't leave the gate claiming
     to be full forever. */
  // Invite refusals, same delivery route as the seat message below: the
  // trigger's own text arrives as `message` with a 500. Named separately
  // because "you're not on the list" and "that code is wrong" are different
  // problems and the second one is fixable by the person reading it.
  if (/no invite for this address/i.test(s))
    return "That email isn't on the invite list. Use the address your invite was sent to, "
      + "or join the waitlist at lynxr.io.";
  if (/invite code does not match/i.test(s))
    return "That invite code isn't right — check the link in your invite email.";

  if (/signups are closed|seats are taken/i.test(s)
      || /database error saving new user|unexpected_failure/i.test(s)) {
    refreshSeats();
    return FULL_MSG;
  }
  if (/already registered|already been registered|user already/i.test(s))
    return "That email already has an account — sign in instead.";
  if (/password/i.test(s) && /short|least|weak|characters/i.test(s))
    return "That password is too short — use at least 8 characters.";
  if (/valid email|invalid.*email|email.*invalid|unable to validate/i.test(s))
    return "That doesn't look like a valid email address.";
  if (/rate|too many|429|for security purposes/i.test(s))
    return "Too many attempts — wait a minute and try again.";
  if (/signups? not allowed|signup.*disabled|not allowed for this instance/i.test(s))
    return "Sign-ups are closed right now — ask Lynx for an invite.";
  return "Couldn't create the account — check your connection and try again.";
}

async function sbRefresh(refresh_token) {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token }),
  });
  if (!res.ok) throw new Error("refresh failed");
  adoptSession(await res.json());
}

/** Access tokens expire hourly; refresh once and retry rather than dumping the
    creator back to the login screen mid-session. */
async function sbFetch(path, opts = {}) {
  const attempt = () => fetch(SB_URL + path, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_TOKEN || SB_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  let res = await attempt();
  if (res.status === 401 && loadSession()?.refresh_token) {
    try {
      SB_REFRESHING = SB_REFRESHING
        || sbRefresh(loadSession().refresh_token).finally(() => { SB_REFRESHING = null; });
      await SB_REFRESHING;
      res = await attempt();
    } catch { /* fall through to the normal error */ }
  }
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
  const text = await res.text();          // writes come back 200 with an empty body
  return text ? JSON.parse(text) : null;
}

// ---------- persistence ----------
// One row per creator, keyed on auth.uid(); RLS makes it unreachable by anyone
// else. Saves are debounced because typing in a company form fires constantly.
let SAVE_T = null;
// True from the moment an edit is made until it is safely on the server. The
// sync loop refuses to pull while this is set: a pull mid-debounce replaces ME
// with the server's copy, and the pending write then posts that back over the
// edit that triggered it.
let SAVE_PENDING = false;

/* ---------- A SEND MUST SURVIVE THE NETWORK ----------

   MEASURED 2026-08-17. A creator pasted a reel at 23:46:01Z. The Fly worker ran
   a full sweep at 23:55, 23:58, 00:01, 00:05 and 00:08 and logged "nothing
   queued" every time; it finally saw the row at 00:11:05 and had the script
   written 45 seconds later. The worker was never down. The send had simply
   never reached Supabase — and for those 25 minutes the card on the creator's
   screen told them it was queued and would be picked up.

   Three things made a single failed POST unrecoverable:

     1. save() caught the failure, set a badge, and NEVER TRIED AGAIN.
     2. ME lived only in a variable, so locking the phone or discarding the tab
        took the send with it.
     3. pull() replaced ME wholesale, so the next successful read DELETED the
        unsent send from local state — the creator's slot spent, nothing to show.

   The three matching guarantees are below and in pull(): the row is mirrored to
   the device before the network is touched, a failed write retries until it
   lands, and a pull merges rather than overwrites.

   This is the half of the wait the poll cannot help with. The adaptive poll
   below closes the gap between a script being FINISHED and being SEEN; nothing
   down there can help a send that never left the building. */

let DIRTY = false;      // an edit the server has not acknowledged
let RETRY_T = null;
let RETRY_N = 0;
// Backoff, then a steady minute. It never gives up while the tab is open: the
// creator has already spent a script slot, so "we stopped trying" is not an
// outcome worth having. The reconnect handlers below jump the queue.
const RETRY_MS = [2000, 5000, 10000, 20000, 30000, 60000];

/* The device mirror. Keyed per account: a phone gets shared, and one creator's
   library is not another's to find. Cleared on sign-out for the same reason. */
const meKey = () => `lynxr_creator_row_${SB_UID || "anon"}`;
function saveLocalMe() {
  // Private mode and quota both throw. Losing the mirror is survivable — the
  // network path still runs — so this must never take the send down with it.
  try { localStorage.setItem(meKey(), JSON.stringify({ data: ME, dirty: DIRTY })); } catch {}
}
function clearLocalMe() { try { localStorage.removeItem(meKey()); } catch {} }
/** Adopt the device mirror into ME. Returns whether there was one to adopt. */
function restoreLocalMe() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(meKey())); } catch { return false; }
  if (!saved?.data) return false;
  ME = { ...BLANK_ME, ...saved.data };
  if (saved.dirty) DIRTY = true;
  return true;
}

function scheduleRetry() {
  clearTimeout(RETRY_T);
  const wait = RETRY_MS[Math.min(RETRY_N, RETRY_MS.length - 1)];
  RETRY_N += 1;
  RETRY_T = setTimeout(() => { if (DIRTY) save({ now: true }); }, wait);
}

function save({ now = false } = {}) {
  SAVE_PENDING = true;
  DIRTY = true;
  // On the device BEFORE the network is involved, so the send outlives the tab
  // whatever the connection does next.
  saveLocalMe();
  renderSyncBadge("saving");
  clearTimeout(SAVE_T);
  const run = async () => {
    try {
      await sbFetch("/rest/v1/lynxr_creators", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: SB_UID, data: ME }),
      });
      SYNC_OK = true;
      DIRTY = false;
      RETRY_N = 0;
      clearTimeout(RETRY_T);
      RETRY_T = null;
      saveLocalMe();                 // record that it landed
    } catch (ex) {
      SYNC_OK = false;
      /* THE ONE FAILURE RETRYING CANNOT FIX. supabase/write_guards.sql bounds
         a creator's row at 1 MB, and a row over it is refused identically on
         every attempt — so the outbox above would back off, retry, back off
         and retry for as long as the tab is open, telling the creator "offline
         — retrying" about a connection that is fine. Say what is actually
         wrong instead, once, and name the fix.

         MATCHED TWO WAYS, AND THE SECOND IS THE ONE THAT WILL ACTUALLY FIRE.
         PostgREST returns {"code","details","hint","message"} in that key
         order, and sbFetch keeps only the first 160 characters of the body.
         For a check violation Postgres fills `details` with "Failing row
         contains (…)" — around 110 characters even after it truncates each
         column to 64 — so the constraint NAME, which lives in `message`, sits
         at roughly character 160 and is as likely to be cut off as not.
         `"code":"23514"` is the 3rd character of the body and always survives;
         23514 is check_violation, and the size guard is the only check
         constraint on lynxr_creators, so on this request it means exactly one
         thing. The name is matched too, for the day the slice gets longer or
         a second constraint makes the code ambiguous.

         The edit is not lost — saveLocalMe() above ran before the network was
         touched, so it is on the device, and deleting entries makes the next
         save() smaller and dirty again, which is exactly the remedy the
         message names. */
      const err = String(ex?.message || "");
      if (/lynxr_creators_data_size/.test(err) || /"code"\s*:\s*"23514"/.test(err)) {
        DIRTY = false;               // the badge must not claim a retry we are not making
        clearTimeout(RETRY_T);
        RETRY_T = null;
        say("Your library is too large to save — delete some entries.", "bad");
      } else {
        scheduleRetry();
      }
    }
    SAVE_PENDING = false;
    renderSyncBadge();
  };
  if (now) return run();
  SAVE_T = setTimeout(run, 800);
  return Promise.resolve();
}

/* The two moments a dead connection actually comes back. Waiting out the rest
   of a backoff after the phone is already on wifi again is dead time on the one
   number that matters — how long the creator waits for their script. */
addEventListener("online", () => { if (DIRTY) save({ now: true }); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && DIRTY) save({ now: true });
});

/** Fill in anything a stored row predates, and return whether it changed —
    the caller saves only when it did, so a clean row costs no write. The
    library shipped after scripts did, so every existing adaptation needs a
    library entry retrofitted or a creator's earlier pastes would be missing
    from the company folder they now browse. */
function normalizeMe() {
  ME = { ...BLANK_ME, ...ME };
  let changed = false;
  for (const k of ["niches", "brands", "adaptations", "library", "trash"]) {
    if (!Array.isArray(ME[k])) { ME[k] = []; changed = true; }
  }

  // The Library holds one entry per VIDEO, account-wide. An earlier build kept
  // a separate copy per brand, so the same link sent to three brands showed up
  // three times — collapse those onto the oldest entry and repoint its scripts.
  const byCanon = new Map();
  const merged = [];
  for (const l of ME.library) {
    const keep = byCanon.get(l.canon);
    if (!keep) { byCanon.set(l.canon, l); merged.push(l); continue; }
    keep.title = keep.title || l.title;
    keep.creator = keep.creator || l.creator;
    keep.caption = keep.caption || l.caption;
    if (l.addedAt && (!keep.addedAt || l.addedAt < keep.addedAt)) keep.addedAt = l.addedAt;
    for (const a of ME.adaptations) if (a.libraryId === l.id) a.libraryId = keep.id;
    changed = true;
  }
  ME.library = merged;
  for (const l of ME.library) {
    if ("brandId" in l) { delete l.brandId; changed = true; }   // a video is not a brand's
    if ("note" in l && !l.note) { delete l.note; changed = true; }
  }

  // Every script needs a Library entry behind it, including ones written before
  // the Library existed.
  for (const a of ME.adaptations) {
    if (!a.sourceUrl) continue;
    const key = canonUrl(a.sourceUrl);
    let item = byCanon.get(key);
    if (!item) {
      item = {
        id: newId(), url: a.sourceUrl, canon: key, platform: platformLabel(a.sourceUrl),
        // realTitle, so a URL stored by the old sourceLabel fallback does not
        // ride into the rebuilt entry and then block it from ever hydrating.
        title: realTitle(a.title), creator: "", caption: "",
        addedAt: a.addedAt || new Date().toISOString(),
      };
      byCanon.set(key, item);
      ME.library.push(item);
      changed = true;
    }
    if (a.libraryId !== item.id) { a.libraryId = item.id; changed = true; }
  }

  // THE WORKER ALREADY KNOWS THE CAPTION. It rides in on the adaptation as
  // source.meta.title (yt-dlp, server side) and nothing here ever read it.
  // Copied onto the entry rather than derived every paint, because a stored
  // caption is what makes hydrateStale() skip this row and what the card
  // body shows under the name. Only a REAL caption is adopted — never a
  // derived label, never source.meta.creator (a numeric uploader id).
  for (const item of ME.library) {
    if (realTitle(item.title)) continue;
    const found = recordsForVideo({ item }).map(metaTitle).find(Boolean);
    if (!found) continue;
    item.title = found;
    item.caption = item.caption || found;
    changed = true;
  }
  return changed;
}

// Which adaptation ids the server was last seen holding, and whether it has
// ever answered at all. A card can then tell "queued, the worker will get to
// it" apart from "this never left your phone" — two waits that look identical
// on screen and need completely different things from the creator.
let SERVER_IDS = new Set();
let SERVER_SEEN = false;

/** Has the server acknowledged this send? False only before the first
    successful pull, or for something still sitting in the outbox. */
function landed(a) { return !SERVER_SEEN || SERVER_IDS.has(a.id); }

/** The server copy wins for everything it knows about — the worker owns
    status, the script, the shots, the cover, and clobbering those with a stale
    local copy is how a finished script would flicker back to "writing".

    What the server CANNOT know about is a send that never reached it. Anything
    local whose id is absent from the server's copy is therefore carried across
    rather than dropped. Without this, one failed write plus one successful pull
    silently deleted the creator's send — slot spent, nothing to show for it.

    A local DELETE that never synced loses to the server and comes back. That is
    the deliberate direction: resurrecting a script someone deleted is a
    nuisance, losing one they are waiting on is the bug this whole block exists
    to stop. */
function mergeUnsent(server, local) {
  const known = new Set((server.adaptations || []).map((a) => a.id));
  const unsent = (local.adaptations || []).filter((a) => a.id && !known.has(a.id));
  if (!unsent.length) return server;
  DIRTY = true;                        // there is something here to push back
  server.adaptations = [...unsent, ...(server.adaptations || [])];
  // Their library entries have to come too, or the card renders with no source.
  const libKnown = new Set((server.library || []).map((l) => l.id));
  server.library = [...(local.library || []).filter((l) => l.id && !libKnown.has(l.id)),
                    ...(server.library || [])];
  return server;
}

async function pull() {
  const rows = await sbFetch(`/rest/v1/lynxr_creators?id=eq.${SB_UID}&select=data`);
  if (rows && rows[0]?.data) {
    const server = { ...BLANK_ME, ...rows[0].data };
    SERVER_IDS = new Set((server.adaptations || []).map((a) => a.id));
    SERVER_SEEN = true;
    ME = mergeUnsent(server, ME);
  }
  SYNC_OK = true;
  saveLocalMe();
  if (normalizeMe()) save();
  else if (DIRTY) save({ now: true });   // an unsent send survived the merge
}

function renderSyncBadge(state) {
  const el = document.getElementById("sync-state");
  if (!el) return;
  // The rail already prints the address underneath, so the badge is just the
  // state — repeating the email there read as a second account.
  el.className = "sync-state " + (state === "saving" ? "" : SYNC_OK ? "ok" : "bad");
  // "not syncing" read as a dead end. There is an outbox behind this now, so
  // say which of the two states it actually is — still trying, or nothing to do.
  el.textContent = state === "saving" ? "● saving"
    : SYNC_OK ? "● synced"
    : DIRTY ? "● offline — retrying"
    : "● not syncing";
}

// ---------- transient messages ----------
const MSG_T = new Map();
// Elements that render as the always-visible composer-note style rather than
// the bp-msg fade widget — keyed by id because #lib-flash and #brand-flash
// carry that class in markup (1508, 1195) even though they aren't literally
// #composer-note. Anything not listed here defaults to bp-msg, same as today.
const FLASH_STYLE = { "composer-note": "composer-note", "lib-flash": "composer-note", "brand-flash": "composer-note" };
function flashMsg(elId, text, tone) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text;
  el.className = `${FLASH_STYLE[elId] || "bp-msg"} show${tone ? " " + tone : ""}`;
  clearTimeout(MSG_T.get(elId));
  MSG_T.set(elId, setTimeout(() => {
    const e2 = document.getElementById(elId);
    if (e2) e2.className = FLASH_STYLE[elId] || "bp-msg";
  }, 5000));
}
// #composer-note only exists on the New script view; the rest are the same
// flash element on every other view. Picking the target inside a microtask —
// rather than at the moment say() is called — means it doesn't matter whether
// a go() elsewhere in the same handler runs before or after this line: by the
// time the lookup runs, any synchronous view change in the same call stack
// (including go()) has already happened, so the message lands on whichever of
// these is actually on screen.
const SAY_TARGETS = ["composer-note", "lib-flash", "brand-flash", "me-msg", "fb-out"];
function say(text, tone) {
  queueMicrotask(() => {
    for (const id of SAY_TARGETS) {
      if (document.getElementById(id)) { flashMsg(id, text, tone); return; }
    }
  });
}

// ---------- slices ----------
const brandScripts = (b) => ME.adaptations.filter((a) => a.brandId === b.id);

/** Does this script carry TAGS? They are an OBJECT the pipeline writes onto
 *  `source` (format_type, hook_pattern, ...), not an array, so "has tags" is
 *  "has at least one key" — `Object.keys` answers that correctly for either
 *  shape, and for a record that has no `source` at all (a queued send). */
function hasTags(a) {
  const t = (a && a.source || {}).tags;
  return !!t && typeof t === "object" && Object.keys(t).length > 0;
}

/** THE RAIL'S COUNTER — TAGGED VIDEOS, not scripts. Changed 2026-08-19 on the
 *  owner's instruction: "count videos and their tags for the real library not
 *  the archive one", then, asked what the tags clause meant, "only count videos
 *  that have tags". So: library rows — one per video, account-wide — that have
 *  at least one script carrying `source.tags`.
 *
 *  WHY THIS IS A JOIN AND NOT A FIELD READ. Nothing writes tags onto a library
 *  row. Measured against the live database: all 20 library rows across every
 *  creator carry exactly [addedAt, canon, caption, creator, id, platform,
 *  title, url] and not one has tags, while 23 of 23 adaptations have
 *  `source.tags` populated. A video is therefore tagged when its FIRST SCRIPT
 *  is written, never when it is saved. Reuse libScripts() for the join rather
 *  than writing a second one — it already handles rows from before the library
 *  existed, which match on canonical URL instead of libraryId. If the pipeline
 *  is ever changed to tag on save, this number simply rises to include those
 *  videos and nothing here has to change.
 *
 *  WHAT "ARCHIVED OR DELETED" MEANS HERE — CONCRETELY, NOTHING EXTRA TO FILTER.
 *  A library row has no archived flag and no hidden state; there is no way to
 *  keep a video and take it off the list. Removing a video splices the row out
 *  of ME.library outright and sends its scripts to the trash (the `.l-del`
 *  handler in paintLibraryList), and ME.trash holds deleted ADAPTATIONS, never
 *  library rows. So "in ME.library" already means "not deleted, not archived",
 *  and libScripts() reads ME.adaptations only — a video whose every script was
 *  deleted correctly stops being tagged and stops being counted.
 *
 *  THE TRADEOFF, ACCEPTED KNOWINGLY. The brand rows below this in the rail
 *  still count SCRIPTS (brandScripts), so the rail now mixes two units: `4` and
 *  `4` under two brands can sit under a library count of `5` and 4+4 will not
 *  reconcile with it. That arithmetic is exactly why this counter used to be
 *  scripts. It lost to a stronger complaint — the rail's number and the number
 *  of rows the Library shows disagreed, and the badge is named after the
 *  Library. The original reasoning is kept verbatim below rather than deleted,
 *  because it is real and someone will re-propose it.
 *
 *  IT IS STILL NOT THE ROW COUNT, AND THE LIBRARY SAYS SO. A saved-but-never
 *  scripted video has no script, so no tags, so it is not counted — that is
 *  precisely the `orphans` set the Library draws in its own "Not scripted yet"
 *  block, whose heading now reads "N saved, not tagged yet" so the shortfall is
 *  named on screen instead of being a silent mismatch. The Library's own
 *  heading pill was moved onto this same count, so the two numbers a creator
 *  can see at once always agree.
 *
 *  ORIGINAL REASONING, SUPERSEDED — do not restore it without the owner:
 *    "THE RAIL'S COUNTER — scripts, not videos. A video scripted for five
 *     brands counts five. Each script is its own piece of work, and the rail
 *     only reads as one scale if the Library's number and the brands' numbers
 *     are the same unit: `library 6` sitting above `4` and `4` invites the
 *     arithmetic 4+4=8 and then looks broken when it does not land. Brand-less
 *     'original' scripts are counted here too, which is why this is the
 *     adaptation count rather than a sum over brands."
 *
 *  STILL ON ME.library.length, ON PURPOSE — do not swap these: the search
 *  threshold, the empty state, and the "n of m" filter tally. All three size
 *  the LIST, which is every saved video including the untagged ones. Pointing
 *  them here would hide the search box at the wrong moment and make the tally
 *  compare a tagged count against a row count.
 *
 *  ONE DELIBERATE EXCEPTION, ADDED 2026-08-20: with no search running, All
 *  videos and Original scripts print `N tagged of M saved` on that same tally
 *  line. That is not the filter tally comparing two units by accident — it is
 *  the shortfall stated in words, in the two modes that draw no "Not scripted
 *  yet" block to state it. The moment a query narrows the list the line goes
 *  back to `n of m`, rows both sides. See paintLibraryList. */
const taggedVideoCount = () => ME.library.filter((it) => libScripts(it).some(hasTags)).length;

/** Every script written from one saved video, across all brands. Matched on
    libraryId, falling back to canonical URL for rows backfilled from before
    the library existed. */
function libScripts(item) {
  return ME.adaptations.filter((a) => a.libraryId === item.id
    || (!a.libraryId && a.sourceUrl && canonUrl(a.sourceUrl) === item.canon));
}

/** Does this record carry the VIDEO'S OWN script — the verbatim transcript or
    the shot list?
    EVERY finished adaptation does, brand-tied or not. The pipeline extracts the
    source first and rewrites second, storing both on the same record: verified
    on the live data, where all 13 adaptations are brand-tied and all 13 carry
    segments, shots, tags and format alongside their rewritten beats.
    That is what lets "Original scripts" show the video's own words for a video
    you scripted FOR A BRAND, at no extra cost — nothing is queued, nothing is
    re-read, no allowance is spent. The words were already in the record.
    A silent video has no segments but still has shots, so either one counts. */
function hasSourceScript(a) {
  const src = a.source || {};
  const segs = (src.script || {}).segments;
  return (Array.isArray(segs) && segs.length > 0)
      || (Array.isArray(src.shots) && src.shots.length > 0);
}

const brandById = (id) => ME.brands.find((b) => b.id === id);

/* Brands a script can actually be written FOR. A brand with no name gives the
   model "Brand: ?" with everything else "(not given)", so four calls — three of
   them Opus — would go into a script adapted to nothing.

   Filtering here rather than refusing at send time is what stops an unnamed
   brand becoming a dead end. It used to be one: a lone unnamed brand was
   auto-ticked by composeTargets(), then refused for having no name, with no
   prompt to name it because that prompt was gated on having no brands at all.
   Now it simply is not a target, and the send falls through to the video's
   original script.

   Defined up here with the other slices because renderNewScript() calls it —
   as a `const` it would sit in the temporal dead zone for anything that ran
   during initial evaluation. */
const namedBrands = () => ME.brands.filter((b) => (b.name || "").trim());

// ---------- view routing ----------
// One rail, one pane. VIEW says what the pane is showing; nothing else does.
let VIEW = { kind: "new" };      // opening the app starts a fresh script

/* THE SEND CONFIRMATION, AND WHY IT OUTLIVES THE SCRIPT.
   Owner, 2026-08-17: "when i paste a link have it open so the lynxr loading
   logo is there and dont close it unless the user presses to close it."
   So there is no timer, no auto-close on arrival, and no backdrop close —
   the X, Escape and "Read it" are the only three exits, and all three are a
   press. In memory only: a reload drops it, which is right, because the
   library card underneath carries the same state durably. */
let SEND_WATCH = null;   // { lid, adIds: [...], settled: false }

/* THE LIBRARY ENTRY A SEND IS ABOUT. An id, not a node: the poll re-renders
   the whole list every 2.5s while a script is being written, so any node
   captured here is detached within seconds. */
let FOCUS_LID = null;

function focusLibraryEntry({ scroll = false } = {}) {
  if (!FOCUS_LID || VIEW.kind !== "library") return;
  const el = document.querySelector(`.lib-item[data-lid="${CSS.escape(FOCUS_LID)}"]`);
  if (!el) return;
  el.open = true;                       // idempotent: safe on every repaint
  if (!scroll) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
}

/* WHERE A SEND LANDS. Owner, 2026-08-18: "when i paste a video bring me to the
   all videos tab with it expanded so i can see the loading logo."

   The overlay below satisfied the earlier half of the same ask — a persistent
   view of the loading mark that only a press dismisses — but it is a modal, so
   it covered the very thing this one asks to see, and locked the page behind
   it. The expanded library entry is persistent by the same standard: nothing
   closes it but the creator, it survives every repaint now (restoreDisclosures),
   and it already renders the same mark, the same phase and the same rail through
   adaptationHtml's writing branch.

   So the overlay is OFF, not deleted. Flip this to true and the send behaves
   exactly as it did on 2026-08-17 — markup, CSS and all three exits intact. */
const SEND_OVERLAY = false;

/** What a successful send does with the Library it has just navigated to.
    One entry point so all three send paths stay identical, and so the choice
    above is made in one place rather than three. */
function landOnSend(lid, adIds) {
  if (!SEND_OVERLAY) { focusLibraryEntry({ scroll: true }); return; }
  openSendOverlay(lid, adIds);
}

/** Open the send overlay for one or more just-queued adaptations from the
    same paste. Never closes on its own — see the comment on SEND_WATCH. */
function openSendOverlay(lid, adIds) {
  SEND_WATCH = { lid, adIds, settled: false, html: "" };
  const modal = document.getElementById("send-modal");
  if (!modal) return;
  modal.hidden = false;
  document.body.classList.add("modal-open");
  renderSendOverlay();
  document.getElementById("send-close")?.focus();
}

/** Repaint #send-body from the current state of SEND_WATCH.adIds — called on
    open and on every live-sync tick while anything is writing. Rewrites
    #send-body ONLY, never #send-head, so the close button never loses focus
    mid-poll. A no-op once settled, so a finished state can't be repainted out
    from under someone reading it. */
function renderSendOverlay() {
  const modal = document.getElementById("send-modal");
  if (!SEND_WATCH || !modal || modal.hidden || SEND_WATCH.settled) return;
  const body = document.getElementById("send-body");
  if (!body) return;

  const entries = SEND_WATCH.adIds
    .map((id) => ME.adaptations.find((a) => a.id === id))
    .filter(Boolean);
  const writing = entries.filter(isWriting);

  let html;
  if (writing.length) {
    // Oldest still-writing entry, so a two-brand send shows one honest clock
    // rather than two racing ones.
    const oldest = writing.slice()
      .sort((a, b) => String(a.addedAt || "").localeCompare(String(b.addedAt || "")))[0];
    const names = entries.filter((a) => a.brandId)
      .map((a) => (brandById(a.brandId) || {}).name || a.brandName || "this brand");
    const stage = names.length
      ? `Writing it for ${escapeHtml(listOf(names))}`
      : "Reading the video for its original script";
    html = etaBlockHtml(oldest, stage);
  } else if (entries.length && entries.every((a) => a.status === "done")) {
    SEND_WATCH.settled = true;
    html = `<p class="bp-hint good">Your script is ready.</p>
      <div class="sendbox-actions"><button type="button" class="btn" id="send-read">Read it</button></div>`;
  } else {
    // At least one status === "error" — a failure must not spin forever.
    SEND_WATCH.settled = true;
    html = `<p class="bp-hint bad">Something went wrong writing this one.</p>
      <div class="sendbox-actions"><button type="button" class="btn" id="send-read">Read it</button></div>`;
  }
  /* Only rewrite when the BRANCH or the stage text changed. The estimate and
     the rail move on their own through paintEta(), and reassigning innerHTML
     for them restarted the loading mark's 1.9s animation on every 2.5s poll. */
  if (SEND_WATCH.html !== html) {
    SEND_WATCH.html = html;
    body.innerHTML = html;
    document.getElementById("send-read")?.addEventListener("click", closeSendOverlay);
  }
  paintEta(body);
}

/** The only way the overlay closes: the X, Escape, or "Read it" — never the
    backdrop, never a timer, never the script arriving on its own. Closing is
    what scrolls to the library entry: landing underneath a still-open overlay
    would be invisible. */
function closeSendOverlay() {
  const modal = document.getElementById("send-modal");
  if (modal) modal.hidden = true;
  document.body.classList.remove("modal-open");
  SEND_WATCH = null;
  focusLibraryEntry({ scroll: true });
}

function go(view) {
  // Leaving the Library abandons whatever entry a send was pointed at —
  // switching views by hand is a deliberate move elsewhere.
  if (view.kind !== "library") FOCUS_LID = null;
  VIEW = view;
  document.body.classList.remove("side-open");
  renderSide();
  renderPane();
  const s = document.getElementById("pane-scroll");
  if (s) s.scrollTop = 0;
  // go() replaces #pane-head/#pane-body wholesale, so focus falls to <body>
  // and a keyboard user restarts from the top of the document on every
  // navigation. #pane-head carries tabindex="-1" in index.html so it can take
  // focus programmatically without joining the tab order itself.
  document.getElementById("pane-head")?.focus({ preventScroll: true });
}

// ---------- New script ----------
// Modelled on a chat app's new-chat screen: opening lynxr lands here with an
// empty composer, and pressing "New script" from anywhere returns here empty.
// One job on the page, so there is nothing to read before you can start.
function renderNewScript(head, body) {
  // No page title — the greeting below is the title, and repeating it twice
  // above a one-field form is exactly the clutter this view is avoiding.
  head.innerHTML = `
    <button type="button" class="side-toggle" id="side-open" aria-label="Menu" title="Menu" aria-expanded="${document.body.classList.contains("side-open")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>`;
  document.getElementById("side-open").addEventListener("click", (e) => {
    const open = document.body.classList.toggle("side-open");
    e.currentTarget.setAttribute("aria-expanded", open);
  });

  // A brand-new account used to hit a wall here — "Add a company first", with
  // no composer on the page at all. Someone who signs up, pastes the link they
  // came to paste and is told to go and do something else first mostly just
  // leaves: one live account got exactly this far and stopped, with zero
  // companies and nothing in its library. A script does still have to be
  // written FOR something, so the composer now asks for that inline and makes
  // the company as part of the send, instead of sending you away to a form.
  // "No brand yet" means no brand we could WRITE for. A brand that exists but
  // has never been named is the same situation from the creator's side, and
  // gating this on ME.brands.length left them with no prompt and no send.
  const firstRun = !namedBrands().length;

  // Centred greeting over the app's EXISTING composer component. The markup of
  // the composer is deliberately untouched — the `composer-inline` /
  // `composer-row` pair is what all its styling hangs off, and rebuilding it
  // with a different structure dropped those classes and made the input and
  // send button vanish entirely.
  body.innerHTML = `
    <div class="newscript">
      <div class="newscript-greet">
        <svg class="newscript-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M3 3h3l15 15-3 3L3 6zM21 3v3L6 21l-3-3L18 3z"/></svg>
        ${/* One line, doing both jobs. "What are we making?" asked a question
              the composer below already asks, and needed a second line of
              small text to explain what to put in it — so the screen opened
              with a prompt, an explanation, and only then the box. This says
              what lynxr does and what to do next in the same five words, which
              is all a returning creator needs and enough for a new one. */""}
        <h1 class="newscript-h">paste a video, get a script</h1>
      </div>
      ${firstRun ? `<p class="nobrand">
        <button type="button" class="linkish" id="nobrand-add">Add a brand</button>
        to get scripts written for them</p>` : ""}
      <div class="composer composer-inline" id="composer">
        <div class="composer-for" id="composer-for"></div>
        <form class="composer-row" id="composer-form">
          <input type="url" id="composer-url" placeholder="Paste a TikTok / Instagram / Facebook / YouTube link"
            autocomplete="off" spellcheck="false" aria-label="Paste a video link">
          <span class="bp-plat" id="composer-plat"></span>
          <button type="submit" class="composer-send" id="composer-send" aria-label="Get the script">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
          </button>
        </form>
        <p class="composer-note" id="composer-note" role="status" aria-live="polite"></p>
      </div>
    </div>`;

  renderComposeFor();
  wireComposer();
  document.getElementById("nobrand-add")?.addEventListener("click", addBrand);
  // Focus on desktop only — on a phone the keyboard would spring up and cover
  // the company picker before you've chosen who the script is for.
  if (window.matchMedia("(min-width: 761px)").matches) {
    focusComposer();
  }
}

/** Move focus into the composer AND leave a visible mark that we did.

    :focus-visible is a heuristic about how focus ARRIVED, and a script moving
    it onto a freshly rendered view is neither a keypress nor a click — so the
    field matches :focus-within and nothing else, and app.css's
    `.composer-row:focus-within:not(:has(input:focus-visible))` correctly took
    the ring away. What was left was the border swap alone, --line-2 to
    --text-3, measured 2.34:1 as a state change: under the 3:1 floor, on the
    first thing a creator sees on this screen.

    The class is the missing signal — "focus is here because we put it here" —
    and app.css draws the ordinary 2px ring for it. Dropped on the first blur
    so it can never outlive the state it describes; the node itself is thrown
    away on the next render, which takes the listener with it. */
function focusComposer() {
  const input = document.getElementById("composer-url");
  const row = input?.closest(".composer-row");
  if (!input) return;
  if (row) {
    row.classList.add("autofocused");
    input.addEventListener("blur", () => row.classList.remove("autofocused"), { once: true });
  }
  input.focus();
}

/* KEYBOARD-AWARE HEIGHT ------------------------------------------------------
   The composer sits at the foot of the page, which is exactly where a phone
   puts its keyboard. `interactive-widget=resizes-content` in the viewport meta
   handles Chrome and most Android browsers; iOS Safari ignores it and does NOT
   shrink dvh for the keyboard either, so the composer would end up behind it.

   visualViewport is the one measurement that is correct everywhere: it reports
   the area actually visible to the user. Publishing it as --vvh lets the layout
   follow the keyboard up and back down on every device that has one.

   Throttled through rAF because iOS fires resize continuously through the
   keyboard animation, and writing a custom property on every one of those
   events re-runs layout for the whole page mid-animation. */
function trackVisibleHeight() {
  const vv = window.visualViewport;
  if (!vv) return;                       // older browser: the dvh fallback stands
  let queued = false;
  const publish = () => {
    queued = false;
    document.documentElement.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
  };
  const onChange = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(publish);
  };
  publish();
  vv.addEventListener("resize", onChange);
  vv.addEventListener("scroll", onChange);
}
trackVisibleHeight();

function renderSide() {
  document.getElementById("side-who").textContent = SB_EMAIL || "";
  /* THE SERVER'S NUMBER WHEN THERE IS ONE. `granted` is per-account
     (lynxr_allowance.granted), so it is not always 25 — raising one creator's
     limit is one UPDATE and this rail has to say the new number, not the
     constant. ALLOWANCE null means my_allowance() has not answered: fall back
     to the local count, which is what this rail showed before the ledger
     existed. Wording is unchanged either way. */
  const grant = scriptGrant();
  const used = Math.min(ALLOWANCE ? ALLOWANCE.used : scriptsUsed(), grant);
  const quota = document.getElementById("side-quota");
  document.getElementById("side-quota-text").textContent =
    used >= grant ? `${grant}/${grant} — none left`
                  : `${used}/${grant} scripts · ${grant - used} left`;
  // Width via CSSOM, not a style attribute: the CSP drops inline styles, and
  // this exact mistake once shipped bar charts that rendered as nothing.
  // `grant` is guarded because a granted of 0 is a legal row — a suspended
  // account — and 0/0 would paint the bar as NaN%, i.e. as nothing at all.
  document.getElementById("side-quota-fill").style.width =
    `${grant > 0 ? (used / grant) * 100 : 100}%`;
  quota.classList.toggle("spent", used >= grant);
  document.getElementById("nav-library-n").textContent = taggedVideoCount();
  document.getElementById("nav-new").classList.toggle("on", VIEW.kind === "new");
  document.getElementById("nav-library").classList.toggle("on", VIEW.kind === "library");
  document.getElementById("nav-you").classList.toggle("on", VIEW.kind === "you");
  document.getElementById("nav-feedback").classList.toggle("on", VIEW.kind === "feedback");

  const host = document.getElementById("side-list");
  if (!ME.brands.length) {
    host.innerHTML = `<p class="side-empty">No brands yet — add the first company you make videos for.</p>`;
    return;
  }
  // Original scripts are NOT listed here. The rail is companies you write for,
  // and a script that belongs to no company is not one of them — it reached
  // this list once and read as a brand called "Original scripts". They live in
  // the Library, as its third grouping mode.
  host.innerHTML = ME.brands.map((b) => {
    const n = brandScripts(b).length;
    const on = VIEW.kind === "brand" && VIEW.id === b.id;
    // A zero PRINTS. `n || ""` used to blank it, and an empty slot beside a
    // company that has 4 next to it does not read as "none yet" — it reads as
    // a number that failed to arrive. A brand with no scripts is a normal
    // state (you add the company before you script for it), so say so.
    return `<button type="button" class="side-item${on ? " on" : ""}" data-bid="${escapeHtml(b.id)}">
      <span class="side-label">${escapeHtml(b.name || "Untitled brand")}</span>
      <span class="side-count">${n}</span>
    </button>`;
  }).join("");
  host.querySelectorAll(".side-item").forEach((el) =>
    el.addEventListener("click", () => go({ kind: "brand", id: el.dataset.bid })));
}

/* renderOriginals() lived here: a standalone page listing every script that
   belonged to no brand. It is gone, and so is its `originals` view. The
   Library's "Original scripts" tab shows the same set, and the scripts
   themselves now render inline inside each Library entry — so the page was
   both unreachable (nothing linked to it once the loose group went) and a
   second place with the same name, which is what made the two easy to
   confuse in the first place. */

/* KEEP WHAT IS OPEN, OPEN ACROSS A REPAINT.
   renderPane() replaces #pane-head and #pane-body wholesale, so every <details>
   in the pane is destroyed and rebuilt closed. focusLibraryEntry() used to
   rescue one entry — the one a send was pointed at — and nothing else, so a
   video the creator expanded by hand, or a script card inside it, shut on any
   repaint that happened to land.
   Ids, never nodes: the nodes read here are detached by the time they are asked
   for back. */
function openDisclosures(root = document) {
  return {
    lids: [...root.querySelectorAll("details.lib-item[open]")]
      .map((d) => d.dataset.lid).filter(Boolean),
    adids: [...root.querySelectorAll("details.bp-item[open][data-adid]")]
      .map((d) => d.dataset.adid).filter(Boolean),
    /* THE ORIGINAL-SCRIPT ROW inside a card. Keyed on the LIBRARY ENTRY, not
       on the record it borrows: there is one row per card, and "By brand"
       renders the same video under every company that has a script from it,
       so every copy reopens together exactly as the entry itself does.
       Deliberately not data-adid — that id is already on the brand script's
       own <details> in the same card, and restoring it would spring the
       original open every time the brand script was open. */
    oids: [...root.querySelectorAll("details.lib-orig[open]")]
      .map((d) => d.dataset.oid).filter(Boolean),
    /* THE REFERENCE PANEL, keyed on the ADAPTATION it belongs to — one per
       script card, and unlike `oids` it is genuinely per-record, because two
       brand scripts from one video each carry their own. Deliberately
       data-refid rather than data-adid: that attribute is already on the
       script's own <details> in the same card, and reusing it would spring the
       panel open every time the script was open. */
    refs: [...root.querySelectorAll("details.ref-panel[open]")]
      .map((d) => d.dataset.refid).filter(Boolean),
  };
}
function restoreDisclosures(state, root = document) {
  if (!state) return;
  /* Videos first, then the scripts inside them — a script re-opened inside a
     still-shut entry is invisible, which is the exact failure keepOpen() already
     documents. Every copy of an id, not the first match: "By brand" renders the
     same video under every company that has a script from it. */
  for (const lid of new Set(state.lids)) {
    root.querySelectorAll(`details.lib-item[data-lid="${CSS.escape(lid)}"]`)
      .forEach((d) => { d.open = true; });
  }
  for (const adid of new Set(state.adids)) {
    root.querySelectorAll(`details.bp-item[data-adid="${CSS.escape(adid)}"]`)
      .forEach((d) => { d.open = true; });
  }
  for (const oid of new Set(state.oids || [])) {
    root.querySelectorAll(`details.lib-orig[data-oid="${CSS.escape(oid)}"]`)
      .forEach((d) => { d.open = true; });
  }
  /* The panel ships `open` by default, so unlike the loops above this one must
     also be able to CLOSE it — but only for a panel that existed in the
     captured state. A card opened for the first time after a repaint has no
     entry in state.refs and would otherwise be shut by this loop despite
     never having been on screen. */
  const wantRef = new Set(state.refs || []);
  const known = new Set([...(state.refs || []), ...(state.adids || [])]);
  root.querySelectorAll("details.ref-panel[data-refid]").forEach((d) => {
    if (known.has(d.dataset.refid)) d.open = wantRef.has(d.dataset.refid);
  });
}

function renderPane() {
  const open = openDisclosures();
  renderPaneInner();
  restoreDisclosures(open);
  paintEta(document);      // every view's progress blocks, filled in one place
}

function renderPaneInner() {
  const head = document.getElementById("pane-head");
  const body = document.getElementById("pane-body");
  if (VIEW.kind === "new") return renderNewScript(head, body);
  if (VIEW.kind === "you") return renderYou(head, body);
  if (VIEW.kind === "feedback") return renderFeedback(head, body);
  if (VIEW.kind === "brand") {
    const b = brandById(VIEW.id);
    if (b) return renderBrand(head, body, b);
    VIEW = { kind: "new" };                // deleted on another device
  }
  return renderLibrary(head, body);
}

function addBrand() {
  // Pressing this twice used to mint a second blank company, and again, and
  // again — a rail full of "Untitled company" rows that all look identical and
  // none of which can be scripted for (a nameless company is refused at send).
  // If a blank one is already waiting, go finish that instead of adding to the
  // pile.
  const blank = ME.brands.find((b) => !(b.name || "").trim());
  if (blank) {
    go({ kind: "brand", id: blank.id });
    // Land on the field that finishes it — the website box when the lookup
    // panel is up, the name field when they chose to type it in.
    const field = document.querySelector("#pane-body .b-lookup")
      || document.querySelector("#pane-body .b-name");
    if (field) field.focus();
    flashMsg("brand-flash", "Add this brand here first.", "bad");
    return;
  }
  const b = { id: newId(), name: "", site: "", description: "", objective: "",
              niche: "", code: trackCode("LYNX") };
  ME.brands.push(b);
  save();
  go({ kind: "brand", id: b.id });
  const first = document.querySelector("#pane-body .b-name");
  if (first) { first.focus(); }
}

/* Brands whose owner chose to type the details rather than give a website.
   Kept in memory only: it exists to stop the lookup panel reappearing while
   they are still on the page, and a brand with a name never shows it again
   anyway, so there is nothing worth persisting. */
const BRAND_MANUAL = new Set();

/* Brands asking for the website panel back after leaving it — either by
   choosing "Add manually", or after a read that failed. Needed because the
   panel normally only shows for a brand with NO site, and a failed read
   deliberately keeps the URL that was typed. */
const RETRY_LOOKUP = new Set();

/** The one question a new brand asks. Fills name, what-it-is and niche from the
    company's own homepage, then hands over to the normal editor. */
/* Set while a lookup panel is on screen, so the header's tick can run it. The
   panel used to carry its own "Get the details" button beside the tick, making
   confirmation a two-button decision — press one to fetch, the other to keep —
   when it is really one action: take this website and set the brand up from it. */
let BRAND_LOOKUP_RUN = null;

/* Set by a successful lookup, consumed by the render that follows it. The old
   confirmation was a paragraph of green text explaining where the details went,
   which is a lot of reading for "they are behind that button" — a small arrow
   pointing at Details says it without a sentence. */
let POINT_AT_DETAILS = false;

/** Point at Details for a few seconds. Used after a website read AND after the
    details are typed in by hand — either way the brand is now set up and the
    fields have gone behind a button, which is worth saying once. */
function showDetailPoint() {
  const point = document.getElementById("detail-point");
  if (!point) return;
  point.hidden = false;
  setTimeout(() => {
    const again = document.getElementById("detail-point");
    if (again) again.hidden = true;
  }, 6000);
}

function wireBrandLookup(b) {
  const panel = document.getElementById("brand-lookup");
  const input = panel.querySelector(".b-lookup");
  const msg = document.getElementById("lookup-msg");

  const openEditor = () => {
    BRAND_MANUAL.add(b.id);
    /* Clearing RETRY_LOOKUP is not optional. `fresh` is
         RETRY_LOOKUP.has(id) || (!b.site && !BRAND_MANUAL.has(id))
       and the first clause SHORT-CIRCUITS — so once "use their website
       instead" had put the id in RETRY_LOOKUP, adding to BRAND_MANUAL was never
       even read and the lookup panel rendered again. "Add manually" looked
       dead: it fired, re-rendered, and landed on the same screen.
       The two successful-lookup paths already clear it; this one did not. */
    RETRY_LOOKUP.delete(b.id);
    go({ kind: "brand", id: b.id });     // re-render without the lookup panel
  };

  document.getElementById("lookup-skip").addEventListener("click", openEditor);

  const run = async () => {
    const tick = document.getElementById("brand-details");
    const url = asUrl(input.value.trim());
    if (!url) {
      msg.textContent = input.value.trim()
        ? "That's not a website — try lynxr.io, or add the details manually."
        : "Paste their website, or add the details manually.";
      msg.className = "lookup-hint";
      input.focus();
      return;
    }
    /* Rotating status while the read is in flight. These describe what the
       read ACTUALLY does — fetch the page, then pull out the name, what they
       sell, the niche and the audience — rather than claiming a numbered step
       is happening at a given moment. The fetch is most of the wall clock and
       the analysis is near-instant, so per-stage claims would be theatre; this
       is ambient and truthful about the job as a whole. */
    let phase = 0, phaseTimer = null;
    const PHASES = ["Reading their site", "Looking for what they sell",
                    "Working out their niche", "Finding who it's for"];
    const stopPhases = () => {
      clearInterval(phaseTimer); phaseTimer = null;
      document.getElementById("lookup-loader")?.setAttribute("hidden", "");
      const live = document.getElementById("lookup-msg");
      if (live) live.className = "lookup-hint";
    };
    if (tick) {
      // Swap the tick for a spinner and keep the button's own markup so the
      // tick comes back if the read fails. A dimmed, pulsing tick was not
      // legible as "working" — loader-glow animates opacity, which overrode
      // the static dim and left it flickering between full and near-full.
      tick.disabled = true;
      tick.dataset.face = tick.innerHTML;
      tick.innerHTML = `<svg class="ico spin" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.4" stroke-linecap="round" aria-hidden="true"
        ><path d="M12 3a9 9 0 1 0 9 9"/></svg>`;
      tick.setAttribute("aria-label", "Reading their site");
    }
    msg.textContent = PHASES[0];
    msg.className = "lookup-hint working";   // .working supplies the moving dots
    document.getElementById("lookup-loader")?.removeAttribute("hidden");
    // 2.6s, not 1.1s: at the old pace the words changed faster than they could
    // be read, which reads as flicker rather than progress.
    phaseTimer = setInterval(() => {
      phase = (phase + 1) % PHASES.length;
      const live = document.getElementById("lookup-msg");
      if (!live) return stopPhases();      // panel gone: nothing to write to
      live.textContent = PHASES[phase];
    }, 2600);
    try {
      const got = analyzeCompanySite(await readCompanySite(url), url);
      b.name = got.name || b.name;
      b.site = url;
      b.description = got.description || "";
      b.niche = got.niche || "";
      if (b.name) b.code = trackCode(b.name);
      save();
      // Straight into the normal view: the panel is gone, the fields are
      // filled, and Details is there to correct anything that came back wrong.
      stopPhases();
      RETRY_LOOKUP.delete(b.id);
      POINT_AT_DETAILS = true;
      go({ kind: "brand", id: b.id });
    } catch {
      /* The read failed — plenty of sites block automated readers. Don't leave
         them sitting on a panel that just failed with nothing to do but press
         the same button again: move them to the manual form, which is the
         thing that still works.

         The URL is KEPT. It is probably correct — the reader is what failed —
         and it goes to the model with every script, so throwing it away would
         cost them something for a failure that was ours. Keeping it also means
         the Website field shows on the manual form, so they can see and fix it.

         No need to restore the tick here: go() re-renders the header. */
      stopPhases();
      RETRY_LOOKUP.delete(b.id);
      b.site = url;
      save();
      BRAND_MANUAL.add(b.id);
      go({ kind: "brand", id: b.id });
      flashMsg("brand-flash", "Couldn't read that site — add the details here.", "bad");
    }
  };

  BRAND_LOOKUP_RUN = run;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); run(); }
  });
  if (window.matchMedia("(min-width: 761px)").matches) input.focus();
}

// ---------- brand view ----------
function renderBrand(head, body, b) {
  const scripts = brandScripts(b);
  const ready = scripts.filter((a) => a.status === "done" && a.adaptation).length;
  const writing = scripts.filter(isWriting).length;

  head.innerHTML = `
    <button type="button" class="side-toggle" id="side-open" aria-label="Menu" title="Menu" aria-expanded="${document.body.classList.contains("side-open")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    <div class="pane-title">
      <div class="bcard-title" id="brand-heading">${escapeHtml(b.name || "Untitled brand")}</div>
      ${/* No standing script COUNT here any more — the list of scripts is
            directly below and counts itself, and on a phone that chip pushed
            Details and the bin onto a second line.
            The "writing" chip stays, because it is not a count: it is the only
            sign that something is in progress on a page that would otherwise
            look finished while a script is still being written. */""}
      ${writing ? `<span class="chip bp-wait"><i class="bp-dot"></i>${writing} writing</span>` : ""}
      <div class="spacer"></div>
      <button type="button" class="ghost" id="brand-details">Details</button>
      <button type="button" class="ghost danger icon-only b-del" title="Delete this brand"
        aria-label="Delete this brand"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button>
    </div>
    ${/* Arrow LAST so it lands under Details. Leading with it put the arrow at
          the start of the row, ~170px to the left of the button it means. */""}
    <p class="detail-point" id="detail-point" hidden>Brand details are in here<svg
      class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      ><path d="M12 19V5M5 12l7-7 7 7"/></svg></p>
    <p class="pane-sub" id="brand-sub">${escapeHtml(b.niche || "No niche set")}${
      b.objective ? " · " + escapeHtml(b.objective) : ""} · ${plural(scripts.length, "script")}</p>`;

  // A brand nobody has filled in yet asks for ONE thing: the website. Every
  // other field is something the company already says about itself on its own
  // homepage, and a creator typing it from memory produces a worse answer than
  // the source does. The full editor is one click away behind Details, and
  // opens automatically the moment the lookup finishes or is skipped.
  // Once the brand has a name it is SET UP, and the website panel is never
  // shown again — editing a live brand happens in Details, by hand. Re-reading
  // a site would silently overwrite a name, description and niche the creator
  // may have corrected themselves, which is not a thing a "back" button should
  // be able to do.
  const named = !!(b.name || "").trim();
  const fresh = !named
    && (RETRY_LOOKUP.has(b.id) || (!b.site && !BRAND_MANUAL.has(b.id)));
  // Offered while the brand is still unnamed — naming it is what the panel is
  // for. After a failed read the site IS set (we keep what was typed), so the
  // old `!b.site` condition hid the way back exactly when it was most wanted.
  const backToLookup = !fresh && !named;
  const readFailed = backToLookup && !!b.site;

  body.innerHTML = `
    <p class="composer-note" id="brand-flash" role="status" aria-live="polite"></p>
    ${fresh ? `
    <div class="section lookup" id="brand-lookup">
      <p class="lookup-label">Brand website</p>
      <input type="text" class="b-lookup" autocomplete="off" spellcheck="false"
        value="${escapeHtml(b.site || "")}" placeholder="lynxr.io">
      <p class="lookup-hint" id="lookup-msg" role="status" aria-live="polite"></p>
      ${/* The app's established loading mark, not a second invention: the X
            split into four arms that scale out of the centre in clockwise
            turn. Same markup and animation the agency app uses while it reads
            a client site — the identical job, so the identical signal. */""}
      <div class="lookup-loader" id="lookup-loader" hidden>${loaderMark()}</div>
    </div>
    ${/* Outside the box, mirroring "use their website instead" on the manual
          form. The two panels are one choice seen from either side, so the way
          across sits in the same place on both — under the card, not inside it.
          Leaving the panel is not one of the panel's own fields. */""}
    <button type="button" class="linkish b-back-link" id="lookup-skip">Add manually</button>` : ""}
    <div class="section client-editor${fresh ? " collapsed" : " collapsed"}" id="brand-editor">
      <div class="ce-body">
        <div class="ce-grid">
          <label class="ce-field"><span class="lbl">Brand name</span>
            <input type="text" class="b-name" value="${escapeHtml(b.name || "")}" placeholder="e.g. lynxr"></label>
          ${/* Only shown once there IS one — i.e. the lookup found it. Asking for
                a website on the manual form is asking the question the lookup
                already exists to answer, and anyone on this form got here by
                saying they did not have one. */""}
          ${b.site ? `<label class="ce-field"><span class="lbl">Website</span>
            <input type="url" class="b-site" value="${escapeHtml(b.site)}" placeholder="https://…"></label>` : ""}
          <label class="ce-field ce-wide"><span class="lbl">What is it?</span>
            <textarea class="b-desc grow" rows="1"
              placeholder="e.g. scripts for UGC creators">${escapeHtml(b.description || "")}</textarea></label>
          <label class="ce-field"><span class="lbl">Campaign objective</span>
            <input type="text" class="b-obj" value="${escapeHtml(b.objective || "")}" placeholder="e.g. creator sign-ups"></label>
          <label class="ce-field"><span class="lbl">Niche</span>
            <input type="text" class="b-niche" value="${escapeHtml(b.niche || "")}" placeholder="e.g. Creator tools"></label>
        </div>
        <p class="bp-msg" id="brand-msg" role="status" aria-live="polite"></p>
      </div>
    </div>
    ${/* BELOW the box, not inside it. Leaving the form is not one of the form's
          fields, and sitting above "Brand name" it read as a heading for the
          panel it takes you out of. The arrow says which direction you are
          going — this returns to the website panel you came from. */""}
    ${backToLookup ? `<button type="button" class="linkish b-back-link" id="b-back-lookup"
      >&larr; ${readFailed ? "Try again" : "Use their website instead"}</button>` : ""}
    ${/* Hidden until the brand has a name. A script is written FOR a company,
          so offering "add a script" before there is one to write for is an
          invitation to a refusal — better not to offer it at all than to shake
          the form at someone who took us up on it. */""}
    ${(b.name || "").trim() ? `
    <div class="lib-head">
      <h2>Scripts <span class="pill">${scripts.length}</span></h2>
      <button type="button" class="lib-plus" id="brand-add" title="New script" aria-label="New script">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
          aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
    <div id="ad-list"></div>` : ""}`;

  document.getElementById("side-open").addEventListener("click", (e) => {
    const open = document.body.classList.toggle("side-open");
    e.currentTarget.setAttribute("aria-expanded", open);
  });

  const editor = document.getElementById("brand-editor");
  const toggle = document.getElementById("brand-details");
  // Open the full editor for a half-set-up brand — unless the lookup panel is
  // showing, which is the one question we want answered first.
  if (!b.name && !fresh) editor.classList.remove("collapsed");
  BRAND_LOOKUP_RUN = null;          // cleared first: a stale handle from the
  if (fresh) wireBrandLookup(b);    // previous brand would run against it

  if (POINT_AT_DETAILS) { POINT_AT_DETAILS = false; showDetailPoint(); }
  document.getElementById("b-back-lookup")?.addEventListener("click", () => {
    BRAND_MANUAL.delete(b.id);
    RETRY_LOOKUP.add(b.id);          // brings the panel back even with a site set
    go({ kind: "brand", id: b.id });
  });

  // "What is it?" wraps instead of scrolling sideways. A collapsed editor is
  // display:none, where every measurement is 0, so re-fit when it opens.
  const fitDesc = () => autoGrow(editor.querySelector(".b-desc"));

  // A brand is set up once, and the toggle above the empty fields used to read
  // "Done" — which names a state, not an action, so it reads as a label on
  // finished work rather than the button you press to keep what you typed.
  // People filled the form in and navigated away past it. Until the brand has
  // been through setup once it says "Save" and carries the solid fill, so it
  // is the most obvious thing in the row. (Every keystroke is already saved;
  // this is the confirmation people look for, and its absence read as loss.)
  let firstRun = !b.name;
  const syncToggle = () => {
    const open = !editor.classList.contains("collapsed");
    // Save is a green tick, matching the red trash below it. "Done" and
    // "Details" stay words — they name a place to go, which an icon cannot.
    if (firstRun) {
      toggle.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M4 12.5l5.5 5.5L20 7"/></svg>`;
      toggle.title = "Save this brand";
      toggle.setAttribute("aria-label", "Save this brand");
    } else {
      toggle.textContent = open ? "Done" : "Details";
      toggle.removeAttribute("title");
      toggle.removeAttribute("aria-label");
    }
    toggle.classList.toggle("icon-only", firstRun);
    toggle.classList.toggle("good", firstRun);
    toggle.classList.toggle("pane-save", false);
  };
  syncToggle();
  fitDesc();

  /* SETTING A BRAND UP MEANS FILLING IT IN.
     Every field on this form is rendered only when it applies — Website, for
     instance, appears only when the lookup found one — so "all the inputs" is
     literally every input and textarea still standing in the editor. No list of
     field names to keep in step with the markup.

     Enforced on the SAVE press only, not on "Done" for a brand that already
     exists. That is not squeamishness: 2 of the 4 brands on live accounts are
     missing `objective` and `niche` (they predate those fields). Gating "Done"
     on completeness would open the editor on one of those brands and refuse to
     let the creator back out of it — a trap, on their own data. They still get
     the fields marked, so it is fixable; it just isn't compulsory. */
  const editorFields = () =>
    [...editor.querySelectorAll(".ce-field input, .ce-field textarea")];

  /** Marks every empty field and returns the first, or null when all are set. */
  const markEmpty = () => {
    let first = null;
    editorFields().forEach((el) => {
      const empty = !el.value.trim();
      el.classList.toggle("ce-missing", empty);
      if (empty && !first) first = el;
    });
    return first;
  };
  // Clear a field's flag the moment it stops being empty, so the form stops
  // shouting while you are still fixing it.
  editor.addEventListener("input", (e) => {
    if (e.target.value.trim()) e.target.classList.remove("ce-missing");
  });

  toggle.addEventListener("click", () => {
    // With the lookup panel up, the tick IS "read this website and set the
    // brand up". It re-renders on success, so nothing below this runs.
    if (BRAND_LOOKUP_RUN) { BRAND_LOOKUP_RUN(); return; }
    const open = !editor.classList.contains("collapsed");
    if (firstRun && open) {
      const missing = markEmpty();
      if (missing) {
        // The label goes in verbatim and in quotes. Lower-casing it read as
        // "Fill in what is it? — …", because one of these labels is a question.
        const label = missing.closest(".ce-field")?.querySelector(".lbl")?.textContent || "every field";
        const left = editorFields().filter((el) => !el.value.trim()).length;
        flashMsg("brand-msg", `Fill in “${label}”${left > 1 ? ` and ${left - 1} more` : ""} — every field feeds the script.`, "bad");
        missing.focus();
        return;                                // refuse: the editor stays open
      }
    }
    const wasSetup = firstRun;                 // this press was "Save"
    editor.classList.toggle("collapsed");
    if (firstRun && editor.classList.contains("collapsed")) firstRun = false;
    /* Saving a brand for the first time RE-RENDERS, rather than just collapsing
       the editor. The Scripts heading and its + button are emitted only once the
       brand has a name — and when this page was built it had none, so pressing
       Save left a brand with no way to add a script to it until you navigated
       away and came back. (It showed "Brand details are in here ↑" above an
       empty page, which read as the save having failed.)

       This is the same move the successful website read makes below: set
       POINT_AT_DETAILS, then go(). Both routes now end in the same place. */
    if (wasSetup && editor.classList.contains("collapsed")) {
      POINT_AT_DETAILS = true;
      go({ kind: "brand", id: b.id });
      return;                                  // the DOM below is gone
    }
    syncToggle();
    fitDesc();
  });

  // Bind, don't re-render — the creator is mid-word in these fields.
  //
  // Resolve the brand by ID on every keystroke rather than closing over the
  // object. pull() rebuilds ME from the server response, so every brand object
  // is REPLACED on each sync; a handler holding the old one then writes into a
  // detached copy that save() never sends. That is why company details silently
  // failed to stick — and the `editing` guard below made it permanent, because
  // it skips the re-render (and therefore the rebind) precisely while you type.
  const bind = (sel, key) => {
    const el = editor.querySelector(sel);
    // Not every field is always rendered — Website only appears once there is
    // one. Without this guard a missing field throws here and takes the whole
    // editor down with it.
    if (!el) return;
    el.addEventListener("input", (e) => {
      const live = brandById(b.id);
      if (!live) return;               // deleted on another device mid-edit
      live[key] = e.target.value;
      if (key === "name") {
        document.getElementById("brand-heading").textContent = live.name || "Untitled brand";
        renderSide();
      }
      save();
    });
    // Trim on BLUR, never on input: trimming mid-keystroke makes it impossible
    // to type a space between two words, because the space is eaten the moment
    // it is typed. Without this pass a pasted name keeps its padding — one live
    // account carries a brand called "Medceptor " with a trailing space, which
    // then reads as a different company everywhere the name is compared.
    el.addEventListener("blur", () => {
      const live = brandById(b.id);
      if (!live) return;
      const trimmed = (live[key] || "").trim();
      if (trimmed === live[key]) return;
      live[key] = trimmed;
      el.value = trimmed;
      if (key === "name") {
        document.getElementById("brand-heading").textContent = live.name || "Untitled brand";
        renderSide();
      }
      save();
    });
  };
  bind(".b-name", "name"); bind(".b-site", "site"); bind(".b-desc", "description");
  bind(".b-obj", "objective"); bind(".b-niche", "niche");
  wireGrow(editor.querySelector(".b-desc"));

  // Same plus as the Library's, and it does one thing more: standing in a
  // company is the answer to "who is this for", so it arrives at the composer
  // with this company already ticked instead of asking again.
  // Only rendered once the brand has a name, so there is nothing to guard
  // against here any more — the optional chaining covers the unnamed case.
  document.getElementById("brand-add")?.addEventListener("click", () => {
    COMPOSE_FOR = new Set([b.id]);
    go({ kind: "new" });
  });

  // Deleting a brand takes its scripts — to the trash, not to nothing, so a
  // mistyped company name deleted in a hurry doesn't cost a dozen scripts.
  // The videos stay in the Library: they were yours before any brand existed.
  // Two buttons, one action. The editor's Delete is unreachable while the
  // lookup panel is up (the editor is collapsed behind Details), so a brand
  // made by mistake had no way out of this screen — and the "name your other
  // brand first" guard meant it also blocked making another one.
  const removeBrand = () => {
    ME.brands = ME.brands.filter((x) => x.id !== b.id);
    trashAdaptations((a) => a.brandId === b.id);
    save({ now: true });
    // Deleting the last brand used to land on the Library, which is a list of
    // what you have saved — the least useful answer to "I just cleared this
    // out." The new-script page is where the next thing starts, so go there.
    go(ME.brands.length ? { kind: "brand", id: ME.brands[0].id } : { kind: "new" });
  };
  armDelete(head.querySelector(".b-del"), "Delete this brand", removeBrand);


  renderScripts(b);
}

// ---------- New script ----------
// One place to send a link, and the record of everything ever sent. A video
// belongs to the creator, not to a brand: the same link scripted for three
// companies is still one entry here, listing where each script went.
let LIB_Q = "";
// "brand" answers "what does this client have?"; "all" answers "what have I
// saved?". Both are real questions, so the Library offers both rather than
// picking one. Not persisted — it resets to By company each visit.
let LIB_MODE = "brand";
const LIB_SEARCH_AT = 4;      // searching three items is noise; the box stays hidden

/* ================= FINDING A SCRIPT =================
   One system, used by the brand pages and by the Library: a grid to scan, a
   box to narrow it, a sort to order it. All three run over the JSONB blob the
   app already holds — there is no network call in any of it, and there must
   not be: the whole corpus is one row this creator owns and it is already in
   memory.

   The controls only appear once there are LIB_SEARCH_AT items. Searching three
   things is noise, and on a phone the bar would cost a row of tiles to say so. */

const SORT_LABELS = {
  new:  "Newest first",
  old:  "Oldest first",
  az:   "Title A\u2013Z",
  most: "Most scripts",
};
/* THE SAME RUNG THE PLACEHOLDER ALREADY HAS. The trigger is a <button> now, so
   it sizes to its CURRENT label, not its longest one — but at the default
   ("Newest first" / "Newest") that is at or near the longest label on both
   rungs, so on a phone this is still the width the search field wanted. The
   short face drops the word that the control's own presence already implies:
   you are looking at a SORT control, so "first" is redundant.
   Only the drawn text of the trigger's face changes. Its `aria-label` always
   carries the FULL label plus the control's purpose ("Sort your scripts:
   Newest first"), and the menu rows are always full — see `applyFindSortLabels`
   and `commit()` in `wireFindBar`. */
const SORT_LABELS_SHORT = {
  new:  "Newest",
  old:  "Oldest",
  az:   "A\u2013Z",
  most: "Most",
};
/* Newest first is the default, which IS a change: both lists used to render in
   insertion order, i.e. oldest first. The thing you are looking for in a list
   that has grown too long is almost always recent, and the control says which
   order you are in, so the old order is one click away rather than gone. */
let AD_Q = "";        // brand-page script search
let AD_SORT = "new";
let LIB_SORT = "new";

/* A PHONE GETS A SHORTER PLACEHOLDER. "search titles, brands, captions" is a
   useful hint at 380px of field and truncates to "search titles, h\u2026" at
   163px, which makes the box look both oversized and broken. The full string
   stays on anything wide enough to hold it; the accessible name (aria-label)
   is unchanged at every width, so nothing is lost to a screen reader.

   A MEDIA QUERY OBJECT, NOT A ONE-OFF READ, because a phone rotates. The list
   is only rebuilt on a render, so without the change listener a turn to
   landscape would keep the short string and a turn to portrait would keep the
   truncating one. The handler re-reads the DOM each time rather than closing
   over an element — every repaint replaces these nodes. */
const FIND_NARROW = window.matchMedia("(max-width: 520px)");
/* AND A THIRD RUNG FOR THE SMALLEST PHONES. Measured at 320px: the field is
   127px wide, 103px of it usable, and even "search videos" renders 125px — so
   the short string truncated too. One word always fits, and next to a sort
   control reading "newest first" it is unambiguous. 360px is where
   "search videos" (125px) starts to fit again. */
const FIND_TINY = window.matchMedia("(max-width: 360px)");
const findPlaceholder = (full, brief) =>
  FIND_TINY.matches ? "search" : FIND_NARROW.matches ? brief : full;
function applyFindPlaceholders() {
  document.querySelectorAll("input.find-q").forEach((el) => {
    const full = el.dataset.ph, brief = el.dataset.phShort;
    if (full && brief) el.placeholder = findPlaceholder(full, brief);
  });
}
/* Same width rung, same reason, same re-application on rotate. Rewrites only
   the CLOSED control's face — the menu rows keep the full label at every
   width, and this never touches the value or the accessible name: `data-sort`
   and `aria-label` are owned by `commit()` in `wireFindBar`. */
function applyFindSortLabels() {
  const short = FIND_NARROW.matches;
  document.querySelectorAll("button.find-sort").forEach((btn) => {
    const k = btn.dataset.sort;
    const label = (short ? SORT_LABELS_SHORT[k] : SORT_LABELS[k]) || SORT_LABELS[k];
    const val = btn.querySelector(".find-sort-val");
    if (label && val && val.textContent !== label) val.textContent = label;
  });
}
function applyFindWidthRungs() { applyFindPlaceholders(); applyFindSortLabels(); }
FIND_NARROW.addEventListener("change", applyFindWidthRungs);
FIND_TINY.addEventListener("change", applyFindPlaceholders);

/* ---------- THE SORT MENU ----------
   A button plus a listbox, not a <select>. macOS draws a native select's popup
   at the SELECT'S OWN font-size, and the find bar came off the 16px pin on
   2026-08-19 (see the long note at the .find-bar block in app.css) — so the
   popup inherited 12.5px type and was unreadable. A <select> cannot size its
   popup independently of its closed control; this can. The closed control keeps
   --fs-135 exactly; only the open menu is bigger.

   FOCUS MOVES INTO THE MENU. role="listbox" supports aria-activedescendant and
   a plain button does not, so the <ul> takes focus and the highlighted row is
   named by aria-activedescendant. Escape and a pick both hand focus back to the
   button; tabbing away just closes it (see focusout).

   ONE document-level pointerdown listener, at module scope, not one per bar:
   go() replaces #pane-body wholesale on every navigation, so a per-instance
   document listener would leak one closure per view change. It also gives
   "opening one closes the other" for free. */
function sortMenuParts(wrap) {
  return {
    btn:  wrap.querySelector(".find-sort"),
    menu: wrap.querySelector(".find-sort-menu"),
    opts: [...wrap.querySelectorAll(".find-sort-opt")],
  };
}
function setSortActive(wrap, k) {
  const { menu, opts } = sortMenuParts(wrap);
  opts.forEach((li) => li.classList.toggle("active", li.dataset.k === k));
  const on = opts.find((li) => li.dataset.k === k) || opts[0];
  if (!on) return;
  menu.setAttribute("aria-activedescendant", on.id);
  /* block:"nearest" scrolls the minimum and does nothing at all when the row is
     already visible, so this cannot jog the page. It only earns its keep if the
     option list ever outgrows the menu's max-height. */
  on.scrollIntoView({ block: "nearest" });
}
function closeSortMenu(wrap, refocus) {
  const { btn, menu, opts } = sortMenuParts(wrap);
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  menu.removeAttribute("aria-activedescendant");
  btn.setAttribute("aria-expanded", "false");
  opts.forEach((li) => li.classList.remove("active"));
  if (refocus) btn.focus();
}
function closeSortMenus(except) {
  document.querySelectorAll(".find-sort-wrap").forEach((w) => {
    if (w !== except) closeSortMenu(w, false);
  });
}
function openSortMenu(wrap) {
  closeSortMenus(wrap);
  const { btn, menu } = sortMenuParts(wrap);
  btn.setAttribute("aria-expanded", "true");
  menu.hidden = false;
  setSortActive(wrap, btn.dataset.sort);
  /* focus() scrolls the menu into view by itself; no second scroll call. */
  menu.focus();
}
document.addEventListener("pointerdown", (e) => {
  const t = e.target;
  closeSortMenus(t && t.closest ? t.closest(".find-sort-wrap") : null);
});

/* ---------- THE LIBRARY MODE SWITCHER'S TRAVELLING FILL ----------

   syncLibModes() moves it; placeLibModes() is what you call after the strip is
   (re)built. The split matters:

   NOTHING ANIMATES ON FIRST PAINT. placeLibModes() positions the indicator with
   the transition still disabled, then turns it on one frame later by adding
   .ind-live. Without that split the pill would slide in from x=0 every time the
   Library is rendered — on load, on every navigation back to it, and after
   every save — which is the same class of bug as an entrance animation that
   fires on a grid repaint. A MODE CLICK does not go through here; it calls
   syncLibModes() directly, on a strip that is already live, so that one moves.

   IT IS RE-MEASURED AFTER THE FONTS LOAD. The tabs are text, so their widths
   change the moment the real face swaps in for the fallback — an indicator
   sized against the fallback silently ends up a few pixels wrong and stays that
   way. document.fonts.ready is the hook. Resize is the other one.

   The listeners are attached ONCE, at module scope, and re-read the DOM each
   time rather than closing over an element: every render replaces these nodes.
   Both handlers no-op when the strip is not on screen. */
function syncLibModes() {
  const wrap = document.querySelector(".lib-modes");
  if (!wrap) return;
  const ind = wrap.querySelector(".lib-modes-ind");
  const on = wrap.querySelector(".lib-mode.on");
  if (!ind || !on) return;
  const wr = wrap.getBoundingClientRect(), ar = on.getBoundingClientRect();
  if (!ar.width) return;                       // not laid out yet; nothing to measure
  ind.hidden = false;
  /* + scrollLeft, and it is not optional: under 560px .lib-modes is
     overflow-x:auto so the strip scrolls sideways, and two client rects
     subtracted give a VIEWPORT offset that is wrong by however far it has been
     scrolled. The indicator lives in the scrolled content, so it has to be
     placed in content coordinates. Rects rather than offsetLeft/offsetWidth
     because those round to integers and the tabs are sub-pixel. */
  /* CSSOM, never a style attribute — style-src is 'self' with no
     'unsafe-inline', so an inline style="" is dropped on the floor silently. */
  ind.style.width = ar.width + "px";
  ind.style.transform = `translateX(${ar.left - wr.left + wrap.scrollLeft}px)`;
}
function placeLibModes() {
  const wrap = document.querySelector(".lib-modes");
  if (!wrap) return;
  wrap.classList.remove("ind-live");           // park it, do not slide it
  syncLibModes();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const w = document.querySelector(".lib-modes");
      if (w) w.classList.add("ind-live");
    });
  });
}
window.addEventListener("resize", syncLibModes);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncLibModes);

/** The search + sort row. `id` prefixes the three element ids so a brand page
 *  and the Library can never collide. */
function findBarHtml({ id, q, sort, sorts, placeholder, brief, what }) {
  return `<div class="lib-tools find-bar">
    <input type="search" id="${id}-q" class="find-q" value="${escapeHtml(q)}"
      placeholder="${escapeHtml(findPlaceholder(placeholder, brief))}"
      data-ph="${escapeHtml(placeholder)}" data-ph-short="${escapeHtml(brief)}"
      aria-label="Search ${escapeHtml(what)}"
      autocomplete="off" spellcheck="false">
    <div class="find-sort-wrap">
      <button type="button" id="${id}-sort" class="find-sort"
        aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}-sort-menu"
        aria-label="Sort ${escapeHtml(what)}: ${escapeHtml(SORT_LABELS[sort] || SORT_LABELS.new)}"
        data-sort="${escapeHtml(sort)}" data-what="${escapeHtml(what)}">
        <span class="find-sort-val">${escapeHtml(SORT_LABELS[sort] || SORT_LABELS.new)}</span>
        <svg class="find-sort-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <ul class="find-sort-menu" id="${id}-sort-menu" role="listbox" tabindex="-1"
        aria-label="Sort ${escapeHtml(what)}" hidden>
        ${sorts.map((k) => `<li role="option" class="find-sort-opt" id="${id}-sort-opt-${k}"
          data-k="${k}" aria-selected="${k === sort}">${escapeHtml(SORT_LABELS[k])}</li>`).join("")}
      </ul>
    </div>
    ${/* The live region. It is the ONLY thing that tells a screen reader the
          grid underneath just changed shape — the grid itself is rewritten
          without any announcement. Empty when nothing is filtered, and
          .find-count:empty is display:none, so it says something or nothing. */""}
    <span class="find-count" id="${id}-count" role="status" aria-live="polite"></span>
  </div>`;
}

/** Wire one find bar. `repaint` re-renders ONLY the grid, never the bar — a
 *  rebuilt <input> loses focus and the caret, which makes typing impossible. */
function wireFindBar(id, repaint, setQ, setSort) {
  applyFindWidthRungs();            // the bar was just rebuilt; re-apply the width rules
  const qEl = document.getElementById(`${id}-q`);
  if (qEl) qEl.addEventListener("input", (e) => { setQ(e.target.value); repaint(); });
  const btn = document.getElementById(`${id}-sort`);
  const wrap = btn && btn.closest(".find-sort-wrap");
  if (!wrap) return;
  const { menu, opts } = sortMenuParts(wrap);
  const keys = opts.map((li) => li.dataset.k);
  const activeKey = () => (wrap.querySelector(".find-sort-opt.active") || {}).dataset?.k
    || btn.dataset.sort;

  const commit = (k) => {
    if (!k) return;
    btn.dataset.sort = k;
    btn.setAttribute("aria-label", `Sort ${btn.dataset.what}: ${SORT_LABELS[k]}`);
    opts.forEach((li) => li.setAttribute("aria-selected", String(li.dataset.k === k)));
    applyFindWidthRungs();          // redraws the trigger's face at the right rung
    closeSortMenu(wrap, true);
    setSort(k); repaint();
  };

  /* Enter and Space on a <button> already dispatch click, so opening by
     keyboard needs no extra branch — only the arrow/Home/End keys do. */
  btn.addEventListener("click", () => {
    if (btn.getAttribute("aria-expanded") === "true") closeSortMenu(wrap, true);
    else openSortMenu(wrap);
  });
  btn.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    openSortMenu(wrap);
    if (e.key === "Home") setSortActive(wrap, keys[0]);
    else if (e.key === "End") setSortActive(wrap, keys[keys.length - 1]);
  });
  menu.addEventListener("keydown", (e) => {
    const i = keys.indexOf(activeKey());
    if (e.key === "ArrowDown")      { e.preventDefault(); setSortActive(wrap, keys[Math.min(i + 1, keys.length - 1)]); }
    else if (e.key === "ArrowUp")   { e.preventDefault(); setSortActive(wrap, keys[Math.max(i - 1, 0)]); }
    else if (e.key === "Home")      { e.preventDefault(); setSortActive(wrap, keys[0]); }
    else if (e.key === "End")       { e.preventDefault(); setSortActive(wrap, keys[keys.length - 1]); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); commit(activeKey()); }
    else if (e.key === "Escape")    { e.preventDefault(); closeSortMenu(wrap, true); }
  });
  menu.addEventListener("click", (e) => {
    const li = e.target.closest(".find-sort-opt");
    if (li) commit(li.dataset.k);
  });
  /* Tab out. focusout fires with relatedTarget outside the wrapper (or null),
     which covers Tab, Shift-Tab and a click that lands on another control —
     so there is no separate Tab branch above. Deliberately does NOT commit:
     changing the sort as a side effect of navigating away is worse than losing
     an uncommitted highlight. */
  wrap.addEventListener("focusout", (e) => {
    if (!wrap.contains(e.relatedTarget)) closeSortMenu(wrap, false);
  });
}

/** Every term has to appear somewhere in the haystack — "cloey hook" finds the
 *  Cloey script whose hook you half-remember, which a plain substring cannot. */
function findMatch(hay, q) {
  const terms = String(q || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => hay.includes(t));
}
const findNorm = (s) => String(s || "").toLowerCase();

/** WHAT A SCRIPT IS SEARCHABLE BY. Everything here is either drawn on the card
 *  or is the thing a creator would say out loud about it — the video's title
 *  or caption, whose it was, the company it was written for, and the line it
 *  opens on. The BEATS are deliberately NOT indexed: a hit inside the body of
 *  a collapsed script shows a card with no visible reason to be there. */
function scriptHay(a) {
  const lib = ME.library.find((l) => l.id === a.libraryId)
    || (a.sourceUrl ? ME.library.find((l) => l.canon === canonUrl(a.sourceUrl)) : null);
  const ad = a.adaptation || {};
  const tags = (a.source || {}).tags || {};
  return [
    entryLabel(a), lib && lib.title, lib && lib.caption, lib && lib.creator,
    lib && lib.platform, (brandById(a.brandId) || {}).name, a.brandName,
    ad.hook, ad.cta, ad.caption, (a.format || {}).name,
    tags.format_type, tags.hook_pattern,
  ].map(findNorm).join(" \u0001 ");
}

/** A saved VIDEO, plus everything written from it — the brands it was scripted
 *  for are the second thing anyone remembers about a video. */
function libHay(item) {
  const made = libScripts(item);
  return [
    sourceLabel(item), item.title, item.caption, item.creator, item.url, item.platform,
    ...made.flatMap((a) => [
      (brandById(a.brandId) || {}).name, a.brandName,
      (a.adaptation || {}).hook, (a.format || {}).name,
    ]),
  ].map(findNorm).join(" \u0001 ");
}

const findTime = (o) => Date.parse((o && o.addedAt) || "") || 0;

/** Sort a copy, never the live array — ME.adaptations and ME.library are what
 *  save() sends, and reordering them would rewrite the creator's own row to
 *  change what a <select> shows. */
function findSort(list, key, titleOf, countOf) {
  const out = [...list];
  if (key === "old") out.sort((x, y) => findTime(x) - findTime(y));
  else if (key === "az") out.sort((x, y) =>
    titleOf(x).localeCompare(titleOf(y), undefined, { sensitivity: "base" })
    || findTime(y) - findTime(x));
  else if (key === "most" && countOf) out.sort((x, y) =>
    countOf(y) - countOf(x) || findTime(y) - findTime(x));
  else out.sort((x, y) => findTime(y) - findTime(x));
  return out;
}

/** Nothing matched. Says so, names what was typed, and hands back a way out —
 *  an empty grid on its own reads as "my scripts are gone". */
function findEmptyHtml(q, id) {
  return `<div class="empty find-empty">
    <p>Nothing matches <strong>${escapeHtml(String(q).trim())}</strong>.</p>
    <div class="bp-actions"><button type="button" class="ghost" id="${id}-clear">Clear search</button></div>
  </div>`;
}
/* ================= end finding ================= */

/** Scope sentinel for libraryItemHtml: show only the scripts that belong to NO
 *  company. A Symbol rather than a magic string — it cannot collide with a real
 *  brand id no matter how ids are generated later, and it stays truthy, which
 *  matters because a falsy scope already means "show every script on this
 *  video". */
const SCOPE_ORIGINAL = Symbol("original scripts only");

function renderLibrary(head, body) {
  head.innerHTML = `
    <button type="button" class="side-toggle" id="side-open" aria-label="Menu" title="Menu" aria-expanded="${document.body.classList.contains("side-open")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    ${/* The + sits on the title row, not down with the tabs. On a phone it had
          a line of its own between the tabs and the first video, which read as
          a stray control belonging to neither. Up here it pairs with the
          heading it acts on, and the tabs get the full width back. */""}
    <div class="pane-title"><div class="bcard-title">Library</div>
      <span class="pill">${taggedVideoCount()}</span>
      <div class="spacer"></div>
      <button type="button" class="lib-plus" id="lib-add" title="New script" aria-label="New script">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
          aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button></div>
    ${/* The sub-line is where the pill above it is explained. It has to be:
          the pill counts TAGGED videos and the list below counts every saved
          one, so without a sentence naming the difference the two disagree on
          screen with no reason given — which is the complaint that started
          this. See taggedVideoCount. */""}
    <p class="pane-sub">Every video you've sent. The number counts the tagged ones — a video
      is tagged when its first script is written.</p>`;

  document.getElementById("side-open").addEventListener("click", (e) => {
    const open = document.body.classList.toggle("side-open");
    e.currentTarget.setAttribute("aria-expanded", open);
  });

  body.innerHTML = `
    <div class="section">
      <div class="lib-head">
        <div class="lib-modes" role="tablist" aria-label="How to group the library">
          ${/* The travelling fill. aria-hidden and hidden-until-measured: it
                carries no meaning a screen reader needs (aria-selected on the
                tabs already does), and a 0-width pill parked at the left edge
                would be a stray dot if this script never ran. */""}
          <span class="lib-modes-ind" id="lib-modes-ind" aria-hidden="true" hidden></span>
          <button type="button" class="lib-mode${LIB_MODE === "brand" ? " on" : ""}"
            id="lib-mode-brand" role="tab" aria-selected="${LIB_MODE === "brand"}">By brand</button>
          <button type="button" class="lib-mode${LIB_MODE === "all" ? " on" : ""}"
            id="lib-mode-all" role="tab" aria-selected="${LIB_MODE === "all"}">All videos</button>
          ${/* The third question this list answers: "what did the video itself
                say?" — the scripts that belong to no company. They are otherwise
                only visible as a loose block at the bottom of By company, which
                is where they go to be missed. */""}
          <button type="button" class="lib-mode${LIB_MODE === "original" ? " on" : ""}"
            id="lib-mode-original" role="tab" aria-selected="${LIB_MODE === "original"}">Original scripts</button>
        </div>
      </div>
      <p class="composer-note" id="lib-flash" role="status" aria-live="polite"></p>
      ${ME.library.length >= LIB_SEARCH_AT ? findBarHtml({
        id: "lib", q: LIB_Q, sort: LIB_SORT, sorts: ["new", "old", "az", "most"],
        placeholder: "search titles, brands, captions", brief: "search videos",
        what: "your library",
      }) : ""}
      <div id="lib-list"></div>
    </div>`;

  document.getElementById("lib-add").addEventListener("click", () => go({ kind: "new" }));
  /* SWITCHING MODE NO LONGER REBUILDS THIS VIEW. It used to call
     renderLibrary(), which rewrites body.innerHTML — so the tab strip, the
     indicator and the search field were all destroyed and recreated on every
     click, and an indicator cannot travel between two different elements.
     Nothing in the markup above depends on LIB_MODE except the three tabs'
     own `on` / aria-selected, so the mode change updates those in place and
     repaints only the list. Side effect worth having: typing a filter, then
     switching mode, no longer throws away the caret. */
  const setMode = (m) => {
    if (LIB_MODE === m) return;
    LIB_MODE = m; FOCUS_LID = null;
    document.querySelectorAll(".lib-modes .lib-mode").forEach((b) => {
      const on = b.id === `lib-mode-${m}`;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    });
    syncLibModes();
    paintLibraryList();
  };
  document.getElementById("lib-mode-brand").addEventListener("click", () => setMode("brand"));
  document.getElementById("lib-mode-all").addEventListener("click", () => setMode("all"));
  document.getElementById("lib-mode-original").addEventListener("click", () => setMode("original"));
  placeLibModes();

  /* No re-focus dance any more: paintLibraryList() only ever rewrites
     #lib-list, and the find bar is a sibling of it, so the caret never moves. */
  wireFindBar("lib", paintLibraryList, (v) => { LIB_Q = v; }, (v) => { LIB_SORT = v; });

  paintLibraryList();
}

/** Just the list — so a keystroke in the search box does not rebuild the
    composer underneath the cursor. */
function paintLibraryList() {
  const host = document.getElementById("lib-list");
  if (!host) return;

  if (!ME.library.length) {
    host.innerHTML = `<div class="empty lib-empty">
      ${emptyDemo()}
      <p><strong>Nothing in your library yet.</strong></p>
      <p>Find a video worth remaking, paste the link, and pick who it's for. We write the script
      and it shows up here — one entry per video, however many companies you script it for.</p>
      <div class="bp-actions"><button type="button" class="btn" id="lib-empty-cta">Add your first script</button></div>
    </div>`;
    host.querySelector("#lib-empty-cta").addEventListener("click", () => go({ kind: "new" }));
    return;
  }

  // Backfills captions for entries that never got one. Deliberately not
  // awaited: the list paints now and each name drops in as it arrives.
  hydrateStale();

  /* The haystack is wider than it was: it used to be title/caption/creator/url,
     which cannot answer "the one I wrote for Cloey" or "the one that opens with
     stop scrolling" — the two things a creator actually remembers. See libHay. */
  const q = LIB_Q.trim();
  const shown = findSort(
    q ? ME.library.filter((it) => findMatch(libHay(it), q)) : ME.library,
    LIB_SORT, (it) => sourceLabel(it), (it) => libScripts(it).length);

  /* Two different questions, one line, and never both at once.

     WHILE A SEARCH IS NARROWING THE LIST the only useful number is how much of
     the library the query matched — unchanged, `3 of 5`, sized on rows both
     sides as it always has been.

     UNFILTERED, IN ALL VIDEOS AND ORIGINAL SCRIPTS, it answers the other
     question: why the rail's `library` badge reads lower than the rows on
     screen. It reads lower because it counts TAGGED videos and a saved-but-
     never-scripted one has no script, so no tags (see taggedVideoCount). By
     company mode already names that shortfall next to the rows causing it, in
     the "Not scripted yet" block's own `N saved, not tagged yet` heading; these
     two modes draw no such block, so the tally is the only place the two units
     can be reconciled. Same two words, deliberately, so the three readings are
     recognisably one sentence.

     Silent when the two agree — there is nothing to explain then. */
  const tally = document.getElementById("lib-count");
  if (tally) {
    const saved = ME.library.length;
    const tagged = taggedVideoCount();
    tally.textContent =
      shown.length !== saved ? `${shown.length} of ${saved}`
      : (LIB_MODE === "all" || LIB_MODE === "original") && tagged !== saved
        ? `${tagged} tagged of ${saved} saved`
        : "";
  }

  if (!shown.length) {
    host.innerHTML = findEmptyHtml(q, "lib");
    const clear = document.getElementById("lib-clear");
    if (clear) clear.addEventListener("click", () => {
      LIB_Q = "";
      const box = document.getElementById("lib-q");
      if (box) { box.value = ""; box.focus(); }
      paintLibraryList();
    });
    return;
  }

  if (LIB_MODE === "brand") {
    // One block per company, so "what does Cloey actually have?" is answerable
    // at a glance. A video reused across three companies appears under each —
    // that repetition IS the answer to the question this view asks.
    const blocks = ME.brands.map((b) => {
      const items = shown.filter((it) => libScripts(it).some((a) => a.brandId === b.id));
      if (!items.length) return "";
      const ready = ME.adaptations.filter((a) => a.brandId === b.id && a.status === "done").length;
      const busy = ME.adaptations.filter((a) => a.brandId === b.id && isWriting(a)).length;
      return `<section class="lib-group">
        <div class="lib-group-head">
          <button type="button" class="lib-group-name linkish" data-bid="${escapeHtml(b.id)}">${
            escapeHtml(b.name || "Untitled company")}</button>
          <span class="lib-group-meta">${ready} ready${busy ? ` · ${busy} writing` : ""}</span>
        </div>
        <div class="bp-list script-grid">${items.map((it) => libraryItemHtml(it, b.id)).join("")}</div>
      </section>`;
    }).filter(Boolean).join("");

    // Videos saved but never scripted for anyone still need a home here, or
    // they are invisible in this view.
    //
    // Scripts that belong to NO brand deliberately do NOT get a block here any
    // more — this view is brands, and they have their own tab now. They used to
    // appear as a loose "Original scripts" group, which put the same name in two
    // places on one screen.
    const orphans = shown.filter((it) => !libScripts(it).length);

    const loose = (title, items, meta) => items.length ? `<section class="lib-group">
      <div class="lib-group-head">
        <span class="lib-group-name">${title}</span>
        <span class="lib-group-meta">${items.length} ${meta}</span>
      </div>
      <div class="bp-list script-grid">${items.map((it) => libraryItemHtml(it)).join("")}</div>
    </section>` : "";

    /* "not tagged yet" is not decoration: these are exactly the videos the
       rail's count leaves out (no script, so no tags), and this is the one
       place on screen where that shortfall can be named next to the rows
       causing it. */
    host.innerHTML = (blocks + loose("Not scripted yet", orphans, "saved, not tagged yet"))
      || `<div class="empty"><p>No scripts yet. Send a link and they'll group by brand here.</p></div>`;
    host.querySelectorAll(".lib-group-name[data-bid]").forEach((el) =>
      el.addEventListener("click", () => go({ kind: "brand", id: el.dataset.bid })));
  } else if (LIB_MODE === "original") {
    /* Every video that has an original script — NOT just the ones whose only
       script is original. A video can be scripted for a company AND have the
       video's own words kept; asking for original scripts should show that one
       too. (The loose block in By company mode is deliberately narrower: there
       its job is to catch what no company block would show.)
       SCOPE_ORIGINAL then hides the brand scripts inside the card, so the tab
       shows what it says it shows. */
    /* WIDENED 2026-08-17. This used to read `.some((a) => !a.brandId)`, which
       matched only videos sent with NO company — so the intent described above
       was written but never true, and picking a company meant the video's own
       words were never shown anywhere. Every finished adaptation stores the
       source transcript and shot list next to its rewrite (hasSourceScript), so
       a video scripted for a company belongs here too, at no extra cost. */
    const items = shown.filter((it) =>
      libScripts(it).some((a) => !a.brandId || hasSourceScript(a)));
    host.innerHTML = items.length
      ? `<div class="bp-list script-grid">${items.map((it) => libraryItemHtml(it, SCOPE_ORIGINAL)).join("")}</div>`
      : `<div class="empty"><p><strong>No original scripts yet.</strong></p>
          <p>Every video you send keeps its own words, shots and structure — send one
          for a company or for none, and the untouched version shows up here.</p></div>`;
  } else {
    host.innerHTML = `<div class="bp-list script-grid">${shown.map((it) => libraryItemHtml(it)).join("")}</div>`;
  }
  stopSummaryLinks(host);
  // The Library now renders real script cards inside its entries, so they need
  // the same Copy / Rewrite / Delete wiring the brand pages give them. Without
  // this every button inside a nested script is inert.
  wireAdaptationCards(host);
  wireDisclosureMotion(host);

  /* ONE VIDEO OPEN AT A TIME, for the same reason as one script: an open entry
     runs to a screen or more, so two at once means scrolling past the first to
     find out what the second even is.
     Matched on data-lid, not on identity: "By brand" renders the SAME video
     once under every brand that has a script from it, and those copies are one
     thing. Closing a video's own twin would fight alsoWriteFor(), which
     deliberately reopens every copy after writing a new script. */
  const entries = [...host.querySelectorAll("details.lib-item")];
  entries.forEach((d) => d.addEventListener("toggle", () => {
    if (!d.open) return;
    entries.forEach((other) => {
      if (other.dataset.lid !== d.dataset.lid) other.open = false;
    });
  }));

  host.querySelectorAll(".lib-item").forEach((card) => {
    const item = ME.library.find((l) => l.id === card.dataset.lid);
    if (!item) return;

    // One tap = one more script from a video already saved. Keeping the card
    // open across the repaint matters: the creator is usually adding two or
    // three companies in a row and a collapsing card loses their place.
    card.querySelectorAll(".lib-also-b").forEach((btn) => btn.addEventListener("click", async () => {
      btn.disabled = true;
      const co = brandById(btn.dataset.bid);
      const { queued, skipped } = await alsoWriteFor(item, [btn.dataset.bid], () => {
        paintLibraryList();
        // By company mode renders the same video under every company that has a
        // script from it, so there can be several copies of this card. Reopen
        // all of them — querySelector would pick an arbitrary one and collapse
        // the card the creator was actually working in.
        document.querySelectorAll(`.lib-item[data-lid="${CSS.escape(item.id)}"]`)
          .forEach((el) => { el.open = true; });
      });
      if (queued.length) {
        flashMsg("lib-flash", `Writing it for ${co ? co.name : "that company"} — it'll appear here.`, "good");
        return;
      }
      // Nothing queued — paintLibraryList() above never ran, so this button is
      // still the one on screen. Re-enable it rather than leaving it stuck
      // disabled, and only add a message of our own for the dupe case: a cap
      // refusal already flashed its own explanation inside alsoWriteFor.
      btn.disabled = false;
      if (skipped.length) {
        flashMsg("lib-flash", `You've already got a ${co ? co.name : "that company"} script from that video.`, "bad");
      }
    }));
    /* Delete the video and everything written from it. Scoped to `card`, not
       the document: in "by brand" mode one video renders under every company
       that has a script from it, so there are several .l-del buttons for the
       same entry and a document-wide query would wire the wrong one.

       The scripts go to Trash rather than vanishing — same as deleting them
       one by one — so this is recoverable. The library row itself is dropped,
       because an entry whose video you removed has nothing left to point at. */
    const del = card.querySelector(".l-del");
    if (del) armDelete(del, "Delete video", () => {
      trashAdaptations((a) => a.libraryId === item.id
        || (!a.libraryId && a.sourceUrl && canonUrl(a.sourceUrl) === item.canon));
      ME.library = ME.library.filter((l) => l.id !== item.id);
      save(); renderSide(); renderPane();
    });
  });

  /* focusLibraryEntry() was called here on every repaint, to rescue the one
     entry a send was pointed at from a rebuild that shut everything. Both halves
     of that are gone: repaints are now rare (paneSig) and preserve every open
     disclosure (restoreDisclosures), so the only place a send's entry has to be
     opened is once, at the send itself — see landOnSend(). */
  paintEta(host);
}

/** One saved video as a card.
 *
 *  `scopeBrandId` is set when the card is rendered inside a company's group:
 *  the status chip and the script list then describe THAT company only.
 *  Without it a video scripted for two companies showed the same "writing 1"
 *  chip under both, so a finished Cloey script read as still being written
 *  because Medceptor's copy was — the exact question this view exists to
 *  answer, answered wrongly. */
function libraryItemHtml(item, scopeBrandId) {
  const all = libScripts(item);
  const asOriginal = scopeBrandId === SCOPE_ORIGINAL;
  /* THE ORIGINAL SCRIPT BELONGS TO THE VIDEO, NOT TO A BRAND. One video
     scripted for three companies is three records carrying the SAME transcript
     and shot list, so this tab shows ONE card per video rather than three
     identical ones.
     Prefer a record genuinely sent with no company — it may still be writing,
     and it owns its own delete button. Failing that, borrow the source off
     whichever brand record has one. */
  const originals = () => {
    const own = all.filter((a) => !a.brandId);
    if (own.length) return own;
    const carrier = all.find(hasSourceScript);
    return carrier ? [carrier] : [];
  };
  const made = asOriginal ? originals()
    : scopeBrandId ? all.filter((a) => a.brandId === scopeBrandId)
    : all;
  const spare = brandsWithout(item);
  const href = safeUrl(item.url || "");
  const waiting = made.filter(isWriting).length;
  const done = made.filter((a) => a.status === "done").length;
  /* THE ORIGINAL, REACHABLE FROM A BRAND SCRIPT. Owner, 2026-08-23: "even in
     the branded scripts, add an option to see the original within the same
     expanded card."
     ONE PER CARD, not one per nested script: the transcript belongs to the
     VIDEO. A video scripted for three companies is three records carrying the
     same source.script.segments and source.shots, so three toggles would all
     reveal the same words.
     It costs nothing — the source is already on the record (hasSourceScript),
     so nothing is queued, nothing is re-read and no allowance is spent.
     NOT OFFERED WHEN THE CARD IS ALREADY SHOWING IT. Two ways that happens:
     the Original scripts tab (asOriginal), where the whole card IS the
     original; and All videos mode on a video that was also sent with no
     company, where that no-brand record is inside `made` and adaptationHtml
     renders it in full. Either way a second copy would be a duplicate.
     THE CARRIER MUST HOLD A FINISHED REWRITE (`a.adaptation`). That is what
     keeps the borrowed card on the one branch of adaptationHtml that draws no
     delete button of its own — see `deleteBtn`, which is `ad ? "" : …`. Two
     armed trash cans for one record inside one card is exactly the confusion
     the entry-level delete was removed for.
     Prefer a record already on this card, then borrow off any record for this
     video — the same fallback originals() uses, and the words are identical
     either way. */
  const origCarrier = (a) => a.brandId && a.status === "done" && a.adaptation && hasSourceScript(a);
  const orig = (!asOriginal && made.length && !made.some((a) => !a.brandId))
    ? (made.find(origCarrier) || all.find(origCarrier) || null)
    : null;
  // The second argument is the full wording, the third the short face a TILE
  // draws — see statusChip. The full string is what the accessible name and an
  // opened card still carry, so nothing here changes meaning.
  const chip = !made.length ? statusChip("", "not scripted", "not made")
    /* WRITING, THE SAME SHAPE AS `ready`. Owner, 2026-08-23: "fix the writing
       one too." It was the one arm still putting a bare quantity in the full
       wording (`writing 2`, which is not a sentence) and then dropping it
       entirely on the tile, so a video with three scripts in flight looked
       exactly like a video with one.
       THE PARALLEL WITH THE DONE ARM IS BROKEN ON PURPOSE, and it is grammar,
       not taste. "2 scripts ready" works because `ready` is an adjective sitting
       on the subject. "2 scripts writing" puts a present participle there
       instead, which reads as the scripts doing the writing. The full string is
       the ONLY face that is ever spoken — it is the accessible name, and the
       opened card — so it is written to be heard: "writing 2 scripts".
       Same mechanism as the done arm and deliberately no second one: the count
       goes to statusChip's 5th argument and comes out as .st-n inside the tile
       face, so it is drawn on a closed tile and never beside the sentence.
       The `asOriginal` guard is gone for the same reason it went from the done
       arm — Original scope resolves to at most one record per video, so it can
       only reach the singular branch anyway, and if it ever does hold two the
       count is a true fact about that video rather than a "1" worth hiding. */
    : waiting ? statusChip("bp-wait", waiting > 1 ? `writing ${waiting} scripts` : "writing",
        "writing", true, waiting)
    /* THE STATUS IS `ready`; THE COUNT IS A FOOTNOTE ON IT. Owner, 2026-08-23:
       "for all scripts have them all just say ready and then if there's
       multiple have it just say ready with some tastefully indicator that
       there are N number of scripts for this one format."
       This deliberately OVERRULES the earlier, narrower decision that only the
       Original scope would drop its count (`creator-original-inside-branded-
       card.md`): a chip whose job is to say what state the video is in was
       reporting a quantity instead, and "2 scripts" never actually said
       "finished" out loud — the green did. It applies in all three views.
       The wording stays a SENTENCE — "3 scripts ready", never "ready 3" — so
       the accessible name and the opened card read as English. Only the tile's
       short face swaps the words for the figure; see statusChip and .st-n. */
    : done ? statusChip("good", done > 1 ? `${plural(done, "script")} ready` : "ready",
        "ready", false, done)
    // Same two buckets as the card chip: only a source failure is a fetch
    // failure. `noteKind` is absent on rows written before the worker stamped
    // it, and those keep the old wording.
    : made.some((a) => a.noteKind && a.noteKind !== "fetch")
      ? statusChip("bad", "couldn't write", "no script")
      : statusChip("bad", "couldn't fetch", "no video");

  return `<details class="bp-item lib-item" data-lid="${escapeHtml(item.id)}">
    <summary>
      <span class="bp-caret" aria-hidden="true">▸</span>
      ${thumbHtml(coverUrl({ libraryId: item.id, canon: item.canon }), sourceLabel(item), item.url,
        // The duration rides on the cover on a tile (see thumbHtml/.bp-dur).
        { tile: true, kind: item.platform || "link", dur: lengthLabel(videoSeconds({ item })) })}
      <span class="bp-name">${escapeHtml(sourceLabel(item))}</span>
      ${/* THE PLATFORM CHIP IS GONE, by decision, from both card kinds. It was
            the only thing on a tile that said TikTok from Instagram; the ↗'s
            accessible name carries that now instead, which costs no pixels.
            See the ↗ below. */""}
      ${/* THE STATUS CHIP. On a tile it LEADS THE META ROW under the title,
            with the facts pushed to the right of it — see .script-grid in
            app.css. (It spent a revision as a badge on the cover; the two
            comments here and in adaptationHtml still said so until 2026-08-23,
            long after the CSS had moved it. The cover carries the duration and
            nothing else.) It is here in the markup, in reading order, so a
            screen reader meets it with the rest of the card's facts. */""}
      ${chip}
      ${metaFactsHtml({ item })}
      ${/* Still rendered, hidden on the TILE only (the sort control names the
            order the grid is in, so the date was restating it on every card);
            an opened card runs the row layout and shows it as it always has. */""}
      <span class="bp-when">${escapeHtml(agoLabel(item.addedAt))}</span>
      ${href ? openOriginalHtml(href, item.platform || platformLabel(item.url || "")) : ""}
    </summary>
    <div class="bp-body">
      ${item.creator ? `<p class="bp-hint">@${escapeHtml(item.creator)}</p>` : ""}
      ${item.caption ? `<p class="bp-hint lib-cap">${escapeHtml(item.caption)}</p>` : ""}
      ${/* THE SCRIPT ITSELF, right here. This used to be a list of links, each
            one navigating away — to a brand page, or to a standalone originals
            page that has since been deleted — so reading a script you were
            already looking at cost two clicks and a change of scene. The card
            is the same one the brand pages render, so nothing about a script
            looks or behaves differently for being inline.

            A single script opens expanded: you opened the video to read it.
            Several stay collapsed, because then the list IS the choice. */""}
      ${/* No "N scripts from this" heading: the entry's own summary already
            carries a "1 script" chip, so the heading restated the count
            directly under it. The scripts are self-evidently the scripts. */""}
      ${/* THE ORIGINAL SITS INSIDE .lib-scripts, as its last row — a peer of
            the brand scripts, because that is what it is: another version of
            this one video. Three rules already in app.css then do all the
            styling for free: .lib-scripts .bp-item strips the frame so it
            does not read as a card inside a card, its > summary rule flushes
            it with the caption above, and .bp-item + .bp-item draws the rule
            between it and the last script.
            A NATIVE <details>, not a custom toggle: keyboard operation and
            the expanded state come from the element, it inherits the caret
            rotation and the bp-open/bp-close reveal every other card in this
            app uses, and wireDisclosureMotion() picks it up unchanged.
            NO data-adid ON IT, deliberately. That attribute is what enrols a
            card in wireAdaptationCards' one-script-open-at-a-time rule, and
            the whole point here is that the original opens ALONGSIDE the
            brand script rather than instead of it. It would also collide in
            restoreDisclosures with the brand card's own id. It is keyed on
            the library entry instead — see openDisclosures.
            ORDER MATTERS: adaptationHtml() consumes the SEEN/FLASH
            just-finished bookkeeping for a record on its first call, so the
            brand card must be built before the borrowed one or the green
            arrival flash lands on the wrong card. made.map() is to the left
            of this expression, so it already is. */""}
      ${made.length ? `<div class="bp-list lib-scripts">${made.map((a) => adaptationHtml(
            a, a.brandId ? (brandById(a.brandId) || {}).name : null,
            { nested: true, bare: made.length === 1, asOriginal }
          )).join("")}${orig ? `<details class="bp-item lib-orig" data-oid="${escapeHtml(item.id)}">
            <summary aria-label="Original script — the words and shots from the video itself">
              <span class="bp-caret" aria-hidden="true">▸</span>
              <span class="bp-name">Original script</span>
            </summary>
            <div class="bp-body">${adaptationHtml(orig, null,
              { nested: true, bare: true, asOriginal: true })}</div>
          </details>` : ""}</div>`
        : `<p class="bp-hint">No script from this one yet.</p>`}

      ${spare.length ? `<div class="bp-heading">Also write this for</div>
        <div class="chips lib-also">${spare.map((b) => `
          <button type="button" class="chip pick lib-also-b" data-bid="${escapeHtml(b.id)}"
            >+ ${escapeHtml(b.name)}</button>`).join("")}</div>`
        : ""}
      ${/* "All your brands already have this one." used to sit here when there
            was nobody left to offer. It stated the absence of an option nobody
            was looking for — the chips simply not being there says it, and
            says it without a line of text. */""}
      ${/* The entry's own delete, back after a spell without one. Removing it
            left videos with NO script — the "not scripted" rows — with no way
            out of the Library at all, since the only delete lived inside a
            script card that those entries do not have.

            "Delete video" against a script card's plain "Delete": the noun is
            the whole difference, and it is enough. That was the real problem
            the first time round — two buttons both saying "delete" inside a
            box-in-a-box, where it was genuinely unclear which one took what.
            The nesting is flat now and the labels name their own scope. */""}
      ${/* Deleting is PER SCRIPT: each card carries its own trash, and an entry
            that has scripts shows no entry-level delete at all. A second trash
            underneath them removed the whole video, and nothing about the two
            icons said which was which.

            The one exception is an entry with NO scripts — the "not scripted"
            rows. Their only delete would live inside a script card they do not
            have, so without this they could never leave the Library. It is also
            the only case where the two cannot be confused: there is nothing
            else to delete. */""}
      ${!made.length ? `<div class="bp-actions">
        <button type="button" class="ghost danger icon-only l-del"
          aria-label="Delete this video" title="Delete this video">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            ><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
        </button>
      </div>` : ""}
    </div>
  </details>`;
}

// ---------- you ----------
function renderYou(head, body) {
  head.innerHTML = `
    <button type="button" class="side-toggle" id="side-open" aria-label="Menu" title="Menu" aria-expanded="${document.body.classList.contains("side-open")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    <div class="pane-title"><div class="bcard-title">Settings</div></div>
    <p class="pane-sub">Goes into every script, so it sounds like you.</p>`;
  document.getElementById("side-open").addEventListener("click", (e) => {
    const open = document.body.classList.toggle("side-open");
    e.currentTarget.setAttribute("aria-expanded", open);
  });

  body.innerHTML = `
    <div class="section">
      <div class="ce-grid">
        <label class="ce-field"><span class="lbl">Your name</span>
          <input type="text" id="me-name" value="${escapeHtml(ME.name || "")}" placeholder="e.g. Sarah"></label>
        <label class="ce-field"><span class="lbl">Your niches (comma-separated)</span>
          <input type="text" id="me-niches" value="${escapeHtml((ME.niches || []).join(", "))}"
            placeholder="e.g. EMT education, study, fitness"></label>
        ${/* No "best email" field: the address is already collected at sign-in,
              and asking again produced a second address to keep in step with
              the first for no benefit. `contactEmail` stays in the record —
              anyone who set one keeps it, and the feedback form still prefers
              it — there is just no longer a way to set a new one. */""}
        <label class="ce-field"><span class="lbl">Can we email you about lynxr?</span>
          <select id="me-optin">
            <option value="no"${ME.emailOptIn ? "" : " selected"}>No — account emails only</option>
            <option value="yes"${ME.emailOptIn ? " selected" : ""}>Yes — updates and questions are fine</option>
          </select></label>
      </div>
      <button type="button" class="btn" id="me-save">Save</button>
      <p class="bp-msg" id="me-msg" role="status" aria-live="polite"></p>
    </div>

    <div class="section">
      <h2>Trash <span class="pill">${(ME.trash || []).length}</span></h2>
      <div id="trash-list"></div>
    </div>

    <div class="section">
      <h2>Account</h2>
      ${/* Which account you are signed into, ABOVE the buttons that act on it.
            It sat below them, which meant "sign out" and "delete account"
            appeared before the thing they would sign out of or delete — you
            read the action, then found out whose account it was. */""}
      ${SB_EMAIL ? `<p class="note me-who">${escapeHtml(SB_EMAIL)}</p>` : ""}
      ${/* .me-actions opts this row out of the phone rule that makes action
            buttons grow to fill the row. That rule is right on a script card,
            where the buttons are the point and want big tap targets — here it
            stretched "delete account" to several times the width of "sign out",
            making the irreversible one the largest thing on the page. */""}
      <div class="bp-actions me-actions">
        ${/* Plain ghost, not .danger. Signing out is reversible — you log back
              in — so red was overstating it, and with a genuinely destructive
              Delete account sitting beside it, two red buttons made the one
              that cannot be undone no louder than the one that can. */""}
        <button type="button" class="ghost" id="signout">Sign out</button>
        <button type="button" class="ghost danger" id="account-del">Delete account</button>
        ${/* IN the button row, not on a line of its own below it — pushed to the
              far right and bottom-aligned, so it sits level with the buttons
              instead of floating in the gap underneath them.

              The gate links the policy too, but a creator who signed up months
              ago never sees the gate again, and this is the page they come to
              when they want to know what happens to their data.

              NOT .gate-fine — that class sets `border-bottom` on its links, and
              the phone rule adds padding plus a text underline for the tap
              target. Both drew, so every link had two lines under it: the
              underline against the text and the border at the bottom of the
              padding box. .me-links owns its style so only one can win.

              rel="noopener noreferrer" on the socials: they open in a new tab,
              and noreferrer keeps this app's unlisted URL out of the Referer
              header sent to tiktok and instagram. */""}
        <span class="me-links">
          <a href="https://www.instagram.com/lynxr.io/" target="_blank" rel="noopener noreferrer">instagram</a>
          <span class="x-sep">&middot;</span>
          <a href="https://www.tiktok.com/@lynxr.io" target="_blank" rel="noopener noreferrer">tiktok</a>
          <span class="x-sep">&middot;</span>
          <a href="/privacy/" target="_blank" rel="noopener">privacy policy</a>
        </span>
      </div>
      <p class="note" id="del-msg" role="status" aria-live="polite"></p>
      ${/* (.me-disclose lived here — the two-sentence inline notice about the
            shared format library surviving account deletion, and about the
            public relay that reads a title before the worker has. Removed at
            the owner's direction on 2026-08-19.

            IT WAS REDUNDANT, NOT UNDISCLOSED, and that is why removing it was
            safe: both facts are in privacy/index.html — the surviving library
            under "one thing survives, and we want to be straight about it",
            and the relay by name (allorigins.win, codetabs.com) including that
            it sees the pasted link and the IP. The "privacy policy" link in
            the .me-links row directly above opens that policy IN A MODAL via
            the delegated handler at the top of this file, so both facts are
            one click away from this exact screen. Do not weaken either passage
            in the policy: they are now the only place either is stated. */""}
    </div>

    <p class="you-foot">&copy;
      <a class="entity" href="https://lynxmediagroup.org/" target="_blank" rel="noopener noreferrer">Lynx Media Group LLC</a>
      2026</p>`;

  renderTrash();

  // Single click: signing out is reversible, so the two-click arm the repo
  // uses for real deletes would just be friction. It already sits behind a
  // page rather than in the rail, which is the protection that matters.
  document.getElementById("signout").addEventListener("click", () => {
    clearSession();
    // The mirror goes with the session. A phone gets handed around, and the
    // next person to open this app should not find someone else's library
    // sitting in it before the gate has even been answered.
    clearLocalMe();
    location.reload();
  });

  /* Deleting the account. Two-click armed, like every other destructive action
     here — and unlike Sign out beside it, because this one cannot be undone.
     (No confirm(): browsers suppress a repeated dialog and it returns false
     instantly, which would silently turn "delete" into "do nothing".)

     The work happens in Postgres. delete_own_account() is SECURITY DEFINER and
     takes no arguments, so it can only ever delete auth.uid() — the caller. The
     account row goes, and lynxr_creators follows it via ON DELETE CASCADE, so
     the brands, library, scripts and trash go with it. Nothing is left behind
     for us to clean up by hand, which is what the privacy page promises. */
  armDelete(document.getElementById("account-del"), "Delete account", async () => {
    const btn = document.getElementById("account-del");
    btn.disabled = true;
    flashMsg("del-msg", "Deleting your account…");
    try {
      // sbFetch does not return a Response — it throws on !res.ok and otherwise
      // returns the parsed body, or null for the empty body PostgREST sends back
      // for a `returns void` function. A resolved await here IS the success
      // path; there is no .ok to read off it.
      await sbFetch("/rest/v1/rpc/delete_own_account", { method: "POST" });
      // The account is gone, so the session it belongs to is meaningless. Clear
      // it locally before reloading, or the app boots holding a token for a
      // user that no longer exists. The device mirror is the same story — a
      // deleted account must not leave its library cached on the phone.
      clearSession();
      clearLocalMe();
      location.reload();
    } catch (ex) {
      // PGRST202 is "function not found" — supabase/delete_account.sql has not
      // been run in this project. Name it precisely: everything else here looks
      // identical to a network failure from the browser, and "try again" would
      // be wrong advice for a deployment step that will never fix itself. Same
      // shape as signupError() / accountLoadError(): read the code off the
      // thrown error's message, which is where sbFetch puts it.
      const why = String(ex?.message || "");
      flashMsg("del-msg", /PGRST202/i.test(why)
        ? "Account deletion isn't switched on yet — email us and we'll do it by hand."
        : "That didn't go through. Try again, or email us.", "bad");
      btn.disabled = false;
    }
  });

  document.getElementById("me-save").addEventListener("click", () => {
    ME.name = document.getElementById("me-name").value.trim();
    ME.niches = document.getElementById("me-niches").value.split(",").map((x) => x.trim()).filter(Boolean);
    ME.emailOptIn = document.getElementById("me-optin").value === "yes";
    save({ now: true });
    flashMsg("me-msg", "Saved.", "good");
  });

}

/** The trash list inside Settings. Restore puts a script back on its company;
 *  if that company is gone the script would have nowhere to live, so it is
 *  offered against the companies that still exist instead of failing. */
/** What a SCRIPT is called — in the Trash view and on the script cards alike.
    An adaptation carries its own copy of the title, taken when it was written,
    so one created before its caption loaded stored the old URL fallback — and
    both views rendered that copy directly.

    Resolved the way the Library does it: the live library entry first, because
    it may have hydrated since this script was thrown away; then the entry's own
    copy; then sourceLabel()'s platform wording. Matched on libraryId OR
    canonical URL, since a trash entry can outlive the library row it was made
    from and a sibling entry for the same video may still carry the caption. */
function entryLabel(a) { return videoTitle({ rec: a }); }

/** ONE DELETED SCRIPT AS A TILE — the same `<details class="bp-item">` the
 *  Library and the brand pages render, so every rule in the .script-grid block
 *  applies to it unchanged. It was a `<div class="bp-item trash-row">` toggling
 *  an `.open` CLASS until 2026-08-19; nothing in that block could reach it,
 *  because all forty-odd of those selectors are written against
 *  `<details>`/`<summary>` and `[open]`. Converting the markup was cheaper and
 *  safer than loosening the selectors — see the plan.
 *
 *  NOT built out of libraryItemHtml() or adaptationHtml(). A trash entry is an
 *  ADAPTATION record that can outlive the library row it was made from, and
 *  adaptationHtml's body is wired by wireAdaptationCards() against
 *  ME.adaptations — which a trashed record is not in, so Copy, Edit,
 *  Teleprompter and Try again would all be silently inert. Everything one
 *  level down IS shared: thumbHtml, statusChip, openOriginalHtml, entryLabel,
 *  agoLabel, coverUrl. */
function trashItemHtml(a) {
  const id = escapeHtml(a.id);
  const ad = a.adaptation || {};
  /* The frame, same as everywhere else. Deciding what to restore off eight
     near-identical instagram.com/p/… URLs meant reading permalinks; the
     thumbnail is how you actually recognise which video it was.
     Falls back to coverUrl() because a trash entry keeps its own copy of
     `source` — if that copy predates covers, a sibling of the same video
     still has one (coverUrl already searches the trash as well as the live
     list), and thumbHtml renders a placeholder when neither does. */
  const cover = (a.source || {}).cover
    || coverUrl({ libraryId: a.libraryId, canon: a.sourceUrl ? canonUrl(a.sourceUrl) : "" });
  const href = safeUrl(a.sourceUrl || "");
  const plat = platformLabel(a.sourceUrl || "");
  const when = agoLabel(a.deletedAt);
  const gone = !!a.brandId && !brandById(a.brandId);

  /* WHICH COMPANY, in the chip slot — the card's one prominent field.
     On a tile the cover and the title are the VIDEO, and one video scripted
     for three companies is three identical tiles; the company is the only
     thing that tells them apart, so it gets the chip rather than the status
     (a deleted script has no status worth a colour).

     Three faces. A record with no brandId is the video's own script and says
     so. A company that has since been deleted keeps its name, turns red, and
     carries the explanation in statusChip's `.st-full` — the same two-face
     mechanism that draws "ready" on a tile and "script ready" everywhere
     else, so the accessible name and the opened card both say the whole
     thing. Otherwise: the name. */
  const chip = !a.brandId
    ? statusChip("", "original script", "original")
    : gone
      ? statusChip("bad trash-brand", `${a.brandName || "its company"} — company deleted`,
                   a.brandName || "company deleted")
      : statusChip("trash-brand", a.brandName || "—", "");

  return `<details class="bp-item trash-card" data-adid="${id}">
    <summary>
      <span class="bp-caret" aria-hidden="true">▸</span>
      ${/* `stamp` INSTEAD of `dur`: see thumbHtml. A trash tile's bottom-right
            badge says when it was thrown away, which is the one fact a
            library tile does not have and the one this screen is scanned
            for. */""}
      ${thumbHtml(cover, entryLabel(a), a.sourceUrl, { tile: true, kind: plat, stamp: when })}
      <span class="bp-name">${escapeHtml(entryLabel(a))}</span>
      ${chip}
      ${/* No metaFactsHtml here, unlike a library tile: views is empty on
            nearly every record (see videoViews) and the length would be
            competing with the deleted stamp for a 116px row at 320px. */""}
      ${href ? openOriginalHtml(href, plat) : ""}
      ${/* THE TWO ACTIONS, INSIDE THE SUMMARY. Restore is the whole point of
            this screen, so it must not be behind a disclosure. Both controls
            stop the click reaching the summary — armDelete already does it
            for the bin, and the restore handler does it explicitly — so
            pressing one never also flips the card open. */""}
      <span class="trash-acts">
        <button type="button" class="ghost trash-restore" data-adid="${id}" aria-label="Restore" title="Restore">
          ${/* A bin with an arrow lifting out of it — "take this back out of the
                trash", rather than the generic undo curl, which reads as
                "revert an edit". Same 24-box and 1.8 stroke as the delete icon
                beside it, so the pair looks like a set. */""}
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            ><path d="M12 9V2"/><path d="M9 5l3-3 3 3"/><path d="M4 11h16"/><path
              d="M6 11l1 9a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-9"/></svg>
          ${/* The word survives on the OPEN card, where the row is full width.
                A tile hides it and squares the button off — see .trash-acts in
                app.css. */""}
          <span class="trash-restore-txt">Restore</span>
        </button>
        ${/* Removes the script from YOUR trash only. The pasted video itself
              stays in lynxr_sources — that table is keyed by canonical URL and
              shared across every creator, so one person emptying their bin must
              never take a source row out from under the others. Same rule
              delete_account.sql already follows. */""}
        <button type="button" class="ghost danger icon-only trash-purge" data-adid="${id}"
          aria-label="Delete permanently" title="Delete permanently — the video stays in the shared library">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            ><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
        </button>
      </span>
    </summary>
    ${/* THE BODY CARRIES INFORMATION, NOT A SECOND COPY OF THE BUTTONS. Two
          controls that do the same thing on one card is the trap the Library
          entry's own comment records — there it was two trash icons, and
          nobody could tell which took what. */""}
    <div class="bp-body">
      <p class="bp-hint">${when ? `Deleted ${escapeHtml(when)}` : "Deleted"}${
        a.brandId ? ` · written for ${escapeHtml(a.brandName || "a company")}` : ""}${
        gone ? " · that company has been deleted since, so Restore files this under your first one" : ""}</p>
      ${ad.hook ? `<p class="bp-hint trash-hook">“${escapeHtml(ad.hook)}”</p>` : ""}
    </div>
  </details>`;
}

function renderTrash() {
  const host = document.getElementById("trash-list");
  if (!host) return;
  const items = ME.trash || [];
  if (!items.length) {
    host.innerHTML = `<p class="bp-hint">Nothing deleted.</p>`;
    return;
  }
  // Same backfill the Library runs. Without it, Trash could only ever heal as a
  // side effect of visiting another view, and hydrate() now writes through to
  // ME.trash, so asking here is what makes these rows name themselves.
  hydrateStale();
  host.innerHTML = `<div class="bp-list script-grid">${items.map(trashItemHtml).join("")}</div>`;

  // The ↗ lives inside the <summary> and would otherwise open the video AND
  // flip the card open behind it.
  stopSummaryLinks(host);
  // Animate the card shut as well as open, same as every other disclosure here.
  wireDisclosureMotion(host);

  /* ONE OPEN AT A TIME. An open card takes `grid-column: 1 / -1`, so three at
     once cut the grid into stripes and everything the creator was comparing
     moves. Same shape as the Library's handler. Safe on `toggle` here — unlike
     an adaptation card, a trash card is never rendered already `open`, so the
     insertion-time toggle that <details open> fires cannot reach this. */
  const cards = [...host.querySelectorAll("details.trash-card")];
  cards.forEach((d) => d.addEventListener("toggle", () => {
    if (!d.open) return;
    cards.forEach((other) => { if (other !== d) other.open = false; });
  }));

  /* Permanent delete drops the entry from ME.trash and nothing else. It does
     NOT touch lynxr_sources: that row describes a public video, is keyed by
     canonical URL and is shared by every creator, so emptying one bin must not
     remove it for anyone else. Two-click armed, like every other destructive
     control here — armDelete already stops the click reaching the summary. */
  host.querySelectorAll(".trash-purge").forEach((btn) => armDelete(btn, "Delete permanently", () => {
    const i = (ME.trash || []).findIndex((x) => x.id === btn.dataset.adid);
    if (i < 0) return;
    ME.trash.splice(i, 1);
    save({ now: true });
    renderSide(); renderPane();
  }));

  host.querySelectorAll(".trash-restore").forEach((btn) => btn.addEventListener("click", (e) => {
    /* The button sits INSIDE the <summary> now, and a click that reaches the
       summary is the disclosure's activation behaviour — so without this,
       restoring would also flip the card open on its way out. The bin beside
       it gets the same treatment from inside armDelete, and the ↗ from
       stopSummaryLinks.
       preventDefault is the half that actually does it: the disclosure toggle
       is the click's DEFAULT ACTION, which stopPropagation does not touch.
       Measured 2026-08-23 — with stopPropagation alone the card flipped every
       time. stopPropagation stays, so the summary's own closing-animation
       handler never runs on a click that was not aimed at it. */
    e.stopPropagation();
    e.preventDefault();
    const i = (ME.trash || []).findIndex((x) => x.id === btn.dataset.adid);
    if (i < 0) return;
    const [a] = ME.trash.splice(i, 1);
    delete a.deletedAt;
    // Its company may have been deleted since. Rather than refuse, put it with
    // the first company that still exists and say so — the script is the
    // expensive part, and which folder it sits in is easy to change.
    if (!brandById(a.brandId) && (ME.brands || []).length) {
      a.brandId = ME.brands[0].id;
      a.brandName = ME.brands[0].name;
    }
    ME.adaptations.unshift(a);
    save({ now: true });
    renderSide(); renderPane();
    say(`Restored to ${a.brandName || "your scripts"}.`, "good");
  }));
}

function renderFeedback(head, body) {
  head.innerHTML = `
    <button type="button" class="side-toggle" id="side-open" aria-label="Menu" title="Menu" aria-expanded="${document.body.classList.contains("side-open")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    <div class="pane-title"><div class="bcard-title">Feedback</div></div>
    <p class="pane-sub">Early software — tell us what's broken.</p>`;
  document.getElementById("side-open").addEventListener("click", (e) => {
    const open = document.body.classList.toggle("side-open");
    e.currentTarget.setAttribute("aria-expanded", open);
  });

  body.innerHTML = `
    <div class="section">
      <p class="lede"><strong>Send anything — especially the small stuff.</strong> Half a sentence
        is fine. The tiny annoyances are the ones we can't see from the inside.</p>
      <div class="ce-grid">
        <label class="ce-field"><span class="lbl">What kind of thing is it?</span>
          <select id="fb-kind">
            <option value="broken">Something is broken</option>
            <option value="idea">Something could be better</option>
          </select></label>
        <label class="ce-field"><span class="lbl">Reply to you at</span>
          <input type="email" id="fb-email" value="${escapeHtml(ME.contactEmail || SB_EMAIL || "")}"
            autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="optional"></label>
        <label class="ce-field ce-wide"><span class="lbl">What happened, or what would you want instead?</span>
          <textarea id="fb-msg" rows="5"
            placeholder="e.g. the script for my Reel came back with the wrong hook, or: I want to reorder the beats"></textarea></label>
      </div>
      <button type="button" class="btn" id="fb-send">Send it</button>
      <p class="bp-msg" id="fb-out" role="status" aria-live="polite"></p>
    </div>`;

  document.getElementById("fb-send").addEventListener("click", () => sendFeedback());
}

/** Replace the form with a real acknowledgement. Someone who took the time to
    write up a bug deserves more than a line of grey text that fades after five
    seconds — and if they cannot tell whether it sent, they will either send it
    twice or stop bothering. Both are worse than a panel they dismiss. */
function acknowledgeFeedback(row) {
  const body = document.getElementById("pane-body");
  if (!body) return;
  const broken = row.kind === "broken";
  body.innerHTML = `
    <div class="section">
      <div class="fb-thanks">
        <div class="fb-tick" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
               stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.5 5.5L20 7"/></svg>
        </div>
        <h2 class="fb-thanks-h">Got it — thank you.</h2>
        <p class="fb-thanks-p">Your ${broken ? "bug report" : "suggestion"} has been received and
          will be reviewed by the team. We read every one of these, and they genuinely decide what
          gets built next.</p>
        ${row.email ? `<p class="fb-thanks-sub">If we need more detail we'll reply to
          <strong>${escapeHtml(row.email)}</strong>.</p>`
        : `<p class="fb-thanks-sub">You didn't leave an email, so we can't follow up on this one —
          add one under You &amp; settings if you'd like us to.</p>`}
        <div class="bp-actions">
          <button type="button" class="btn" id="fb-again">Send something else</button>
        </div>
      </div>
    </div>`;
  document.getElementById("fb-again").addEventListener("click", () => renderPane());
}

/* Feedback is written TWICE, on purpose.

   Supabase is the record: RLS-protected, always reachable, and the thing to
   trust if the two ever disagree. The Google Sheet is a convenience mirror so
   feedback lands somewhere you already read.

   The mirror goes through a Google Apps Script web app rather than the Sheets
   API, because this site is static and public — any Google credential shipped
   to the browser would be readable by everyone. An Apps Script deployed as
   "anyone can access" needs no credential at all; it just accepts a POST.

   That endpoint is public, so treat the Sheet as append-only and slightly
   spammable, and Supabase as the source of truth. Sending is fire-and-forget
   (`no-cors`): Apps Script answers with a redirect the browser will not let us
   read, so we cannot confirm it landed — which is exactly why the Supabase
   write is the one whose result the creator is shown. */
const FEEDBACK_SHEET_URL =
  "https://script.google.com/macros/s/AKfycby65vSjjDqXCzLv_1wG49_01maywtyPHDgW1x1srdQSI36Ogg1CxHQYaEYLcRG28RrsCw/exec";

function mirrorToSheet(row) {
  if (!FEEDBACK_SHEET_URL) return;
  try {
    // text/plain dodges the CORS preflight Apps Script will not answer.
    fetch(FEEDBACK_SHEET_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(row),
    }).catch(() => {});
  } catch { /* the Supabase row already landed; the mirror is a bonus */ }
}

async function sendFeedback() {
  const btn = document.getElementById("fb-send");
  const msg = document.getElementById("fb-msg");
  const text = (msg.value || "").trim();
  if (!text) { flashMsg("fb-out", "Write a line or two first.", "bad"); msg.focus(); return; }

  const row = {
    creator_id: SB_UID,
    email: (document.getElementById("fb-email")?.value || "").trim() || SB_EMAIL || "",
    kind: document.getElementById("fb-kind").value,
    message: text.slice(0, 4000),
    page: location.pathname,
  };

  btn.disabled = true;
  try {
    await sbFetch("/rest/v1/lynxr_feedback", { method: "POST", body: JSON.stringify(row) });
    mirrorToSheet({ ...row, name: ME.name || "", created_at: new Date().toISOString() });
    msg.value = "";
    acknowledgeFeedback(row);
  } catch (ex) {
    flashMsg("fb-out", /PGRST205|schema cache/i.test(ex.message || "")
      ? "Couldn't send — the feedback table isn't set up yet (run supabase/schema.sql)."
      : "Couldn't send that — check your connection and try again.", "bad");
  } finally { btn.disabled = false; }
}

// ---------- the library record ----------
// One entry per video, keyed on canonical URL across the WHOLE account — not
// per brand. The same link sent for three brands is one row here that lists
// all three scripts.
function ensureLibraryItem(url, extra = {}) {
  const canon = canonUrl(url);
  const found = ME.library.find((l) => l.canon === canon);
  if (found) { Object.assign(found, extra); return { item: found, isNew: false }; }
  const item = {
    id: newId(), url, canon, platform: platformLabel(url),
    title: "", creator: "", caption: "",
    addedAt: new Date().toISOString(), ...extra,
  };
  ME.library.unshift(item);
  return { item, isNew: true };
}

/* == title resolution == */
/* ONE chain, used by every surface: the Library card, a standalone script
   card, and a row in the Trash. They disagreed before — three call sites,
   three orders — which is how one video could read as its caption in the
   Library and "Instagram post" in the bin.

   NOTHING DERIVED IS EVER STORED. A label computed here is computed again
   on the next paint; only a genuine caption is written to a record. Storing
   a derived label is precisely what froze "Instagram reel" onto 8 live
   records — see queueAdaptation. */

/** A stored title that is really a permalink.

    Not a hypothetical: the brief builder sets an adaptation's `title` to
    sourceLabel(item) at the moment it is written, and sourceLabel USED to
    return the URL when the caption had not loaded yet. So the string was
    saved into the record — and because it is a non-empty string, every
    `title || fallback` test in this file was satisfied by it and no fallback
    ever ran. The same value then rode into library entries rebuilt from
    adaptations (`title: a.title || ""`).

    Treating it as absent is what lets those records heal rather than keep the
    URL for good. Matched on the known video hosts only, so a caption that
    merely mentions a link is left alone. */
const URLISH_TITLE = /^(https?:\/\/)?(www\.|m\.)?(instagram\.com|tiktok\.com|youtube\.com|youtu\.be)\//i;

/** The labels this file GENERATES, recognised on the way back in.

    sourceLabel() has always produced "<Platform> <kind>", "Saved <kind>" and
    "@<handle> on <Platform>", and queueAdaptation used to write the result
    into the record. A stored one then satisfied every `title || fallback`
    test in this file and blocked hydrateScript()'s `!realTitle(a.title)`
    guard for good, so the row could never heal — the same shape of bug as
    URLISH_TITLE, one class wider. "Video by <handle>" is here too: it is
    yt-dlp's synthesised Instagram placeholder, and it arrives on
    source.meta.title whenever the post has no description (6 live records).

    Anchored, so a caption that merely CONTAINS "instagram post" is left
    alone. A caption that is exactly "Instagram post" is treated as absent,
    and the chain below then shows the video's own opening line, which is a
    better answer anyway. */
const PLACEHOLDER_TITLE = new RegExp(
  "^(?:(?:TikTok|Instagram|Facebook|YouTube)\\s+(?:reel|post|short|video)"
  + "|Saved\\s+(?:reel|post|short|video)"
  + "|@[A-Za-z0-9._]+\\s+on\\s+(?:TikTok|Instagram|Facebook|YouTube|Link)"
  + "|Video by\\s+\\S+)$", "i");

function realTitle(s) {
  const t = String(s || "").trim();
  return (URLISH_TITLE.test(t) || PLACEHOLDER_TITLE.test(t)) ? "" : t;
}

/** One line, no runs of whitespace, short enough for a card. */
const tidyTitle = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 90);

/** The caption the WORKER fetched, straight off the record — no network.
    yt-dlp prefers `description` over its "Video by <handle>" placeholder,
    but when the post has no description the placeholder survives, so it is
    filtered here too (realTitle covers it). */
function metaTitle(rec) {
  return realTitle(tidyTitle((((rec || {}).source || {}).meta || {}).title));
}

/** The video's OWN first words, when it has no caption at all.
    Costs nothing: the pipeline already stored the transcript and the shot
    list on this record. Spoken hook first, then the first transcript
    segment, then the first frame's on-screen text — which for a silent
    video IS what the video says. Anything under 8 characters is not a
    title, so it falls through rather than showing "Track". */
function ownWordsTitle(rec) {
  const src = (rec || {}).source || {};
  const sc = src.script || {};
  /* A SEGMENT IS A TUPLE, NOT AN OBJECT. pipeline/transcribe.py writes
     `[start, end, text]` (its `segments` list comprehension), and
     process_adaptations.py reads it back as `for st, en, txt in
     script["segments"]` — adaptationHtml destructures it the same way,
     `segs.map(([st, , txt]) => …)`. Reading `.text` off a tuple is undefined
     for every segment, so this rung never fired: a record with a transcript
     but no hook fell straight through to "Instagram reel", the exact string
     this resolver exists to remove. The object form is still accepted so a
     hand-built record does not silently go dark. */
  const segText = (s) => (Array.isArray(s) ? s[2] : (s || {}).text);
  const seg = (sc.segments || []).map(segText)
    .find((x) => String(x || "").trim());
  const shot = (src.shots || []).map((s) => (s || {}).onscreen_text)
    .find((x) => String(x || "").trim());
  const pick = tidyTitle(sc.hook) || tidyTitle(seg) || tidyTitle(shot);
  return pick.length >= 8 ? pick : "";
}

/** Every record made from this video — live and trashed, this account.
    Matched on libraryId OR canonical URL, because a trashed script outlives
    the library row it was made from and a sibling scripted for another
    brand carries the same source. The record we were handed comes first. */
function recordsForVideo({ item, rec }) {
  const canon = (item && item.canon)
    || (rec && rec.sourceUrl ? canonUrl(rec.sourceUrl) : "");
  const lid = (item && item.id) || (rec && rec.libraryId) || "";
  const mine = [...(ME.adaptations || []), ...(ME.trash || [])].filter((a) =>
    (lid && a.libraryId === lid)
    || (canon && a.sourceUrl && canonUrl(a.sourceUrl) === canon));
  return rec ? [rec, ...mine.filter((a) => a !== rec)] : mine;
}

/** "@handle on TikTok" — identity when we have no words.
    The handle comes from the URL or from the LIBRARY entry, which hydrate()
    fills from the page's og tags. NEVER from source.meta.creator: that is
    yt-dlp's `uploader_id`, which on both Instagram and TikTok is a numeric
    account id ("15453872790"), not a handle. Verified on the live rows. */
function handleLabel(url, lib) {
  const handle = (String(url || "")
    .match(/(?:tiktok\.com|instagram\.com)\/@([A-Za-z0-9._]+)/) || [])[1]
    || (lib && lib.creator) || "";
  return handle ? `@${handle} on ${(lib && lib.platform) || platformLabel(url)}` : "";
}

/** The honest floor: what the entry IS. Only reachable for a link the
    pipeline never fetched — a failed or still-queued send. The cover frame,
    the platform chip and the ↗ beside it are what tell two of these apart. */
function platformKindLabel(url, platform) {
  const kind = /\/reels?\//.test(url) ? "reel"
    : /instagram\.com\/p\//.test(url) ? "post"
    : /\/shorts\//.test(url) ? "short" : "video";
  return platform === "Link" ? `Saved ${kind}` : `${platform} ${kind}`;
}

/** THE chain. Give it a library entry, a script record, or both. */
function videoTitle({ item, rec } = {}) {
  const lib = item || (ME.library || []).find((l) =>
    (rec && rec.libraryId && l.id === rec.libraryId)
    || (rec && rec.sourceUrl && l.canon === canonUrl(rec.sourceUrl)));
  const url = (lib && lib.url) || (rec && rec.sourceUrl) || "";
  const recs = recordsForVideo({ item: lib, rec });
  const first = (fn) => {
    for (const r of recs) { const v = fn(r); if (v) return v; }
    return "";
  };
  return realTitle(lib && lib.title)          // a caption hydrate() stored
    || first((r) => realTitle(r.title))        // one a sibling record kept
    || first(metaTitle)                        // the worker's, no network
    || first(ownWordsTitle)                    // the video's own first words
    || handleLabel(url, lib)
    || platformKindLabel(url, (lib && lib.platform) || platformLabel(url));
}

/** THE VIDEO'S OWN LENGTH, in seconds, off whichever record for this video
 *  kept it — same walk as videoTitle, and for the same reason: fetch_meta()
 *  runs ONCE PER VIDEO and its result is written onto the REPRESENTATIVE
 *  record of the group (process_adaptations.py, `rep.setdefault("source",
 *  {})["meta"]`), so a video scripted for three companies has the number on
 *  one of the three records and not the other two.
 *
 *  Three sources, best first. `source.duration` is the one that actually
 *  covers the corpus: the pipeline writes it from the Whisper pass for every
 *  video it transcribes (fresh or cached), so it is present whenever a script
 *  exists at all. `meta.duration` is yt-dlp's and is missing wherever
 *  fetch_meta failed. Measured against the live database 2026-08-18:
 *  19 of 23 distinct videos resolve a length this way.
 *
 *  0 is NOT a length. A video the pipeline never read has no duration, and
 *  "0:00" would state a measurement we do not have. */
function videoSeconds({ item, rec } = {}) {
  for (const r of recordsForVideo({ item, rec })) {
    const src = r.source || {};
    const d = Number(src.duration) || Number((src.meta || {}).duration)
      || Number((src.script || {}).duration);
    if (d > 0) return d;
  }
  return 0;
}

/** THE VIDEO'S PUBLIC VIEW COUNT, same walk as videoSeconds and for the same
 *  reason (fetch_meta writes onto one record per video, not all of them).
 *
 *  READ THIS BEFORE TRUSTING THE NUMBER. It is almost never there.
 *  pipeline/process_adaptations.py's fetch_meta does
 *  `int(d.get("view_count") or 0)`, so a missing count is stored as 0 rather
 *  than as nothing — the field LOOKS populated everywhere. Measured against
 *  the live database 2026-08-18: of 23 distinct videos, 15 carry a value and
 *  13 of those are exactly 0; 2 are non-zero and one of those two is "27".
 *  lynxr_sources agrees, 0 non-zero across all 27 rows. yt-dlp returns no
 *  count at all for Instagram, which is most of the corpus.
 *
 *  So 0 is treated as ABSENT, not as a measurement, and the card renders
 *  nothing rather than "0" or a dash. The slot is real and will fill itself
 *  the day the number becomes real; today it is empty on almost every card. */
function videoViews({ item, rec } = {}) {
  for (const r of recordsForVideo({ item, rec })) {
    const v = Number(((r.source || {}).meta || {}).views);
    if (v > 0) return v;
  }
  return 0;
}

/** THE NUMBER ONLY — "1", "27", "12k", "1.2m". Nothing at all for 0, see
 *  videoViews.
 *
 *  IT BRIEFLY CARRIED ITS OWN UNIT ("27 views"), because a bare small integer
 *  beside a timestamp is unreadable: the owner's card came back as
 *  `script ready  27  0:17` and the honest question was "what does the 27
 *  mean". The unit is still there twice over — an eye icon for the eye, and the
 *  word itself in the accessible name (see metaFactsHtml) — so the visible
 *  string no longer has to repeat it.
 *
 *  Worth remembering that the fixtures which missed the original defect only
 *  ever seeded 191k and 1.2m: magnitudes that self-describe because of the
 *  suffix, while the ONE non-zero value in the real database is 27. A fixture
 *  that exercises only the comfortable case proves nothing about the
 *  uncomfortable one. */
function viewsLabel(n) {
  const v = Number(n) || 0;
  if (v <= 0) return "";
  if (v < 1000) return String(v);
  /* 999500, not 1e6: at 999,999 the `k` branch rounds to 1000 and the label
     came out "1000k". Anything that would round past 999k belongs a unit up. */
  if (v < 999500) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}k`.replace(".0k", "k");
  return `${(v / 1e6).toFixed(1)}m`.replace(".0m", "m");
}

/** THE TWO FACTS UNDER A CARD'S TITLE — views, then length — as ONE group
 *  pushed to the right of the row, with the status chip left against the other
 *  edge. The gap between the two does the separating: left-packed, the whole
 *  row clumped into the first third of the card and left dead space beside it,
 *  and `27 0:17` read as a single run of characters.
 *
 *  One builder for both card kinds so a library tile and a brand-page tile can
 *  never drift. Each fact is omitted entirely when we do not have it, so the
 *  row is short and true rather than padded with dashes; in practice views is
 *  empty on almost every card (see videoViews) and length is present on most.
 *
 *  NO SEPARATOR CHARACTER between the two. A middot lived here for one
 *  revision, back when the row was left-packed and needed it; with the row
 *  split and the eye anchoring the views, whitespace is enough — and
 *  punctuation the eye does not need is punctuation a screen reader has to
 *  skip. */
function metaFactsHtml({ item, rec } = {}) {
  const views = videoViews({ item, rec });
  const v = viewsLabel(views);
  const len = lengthLabel(videoSeconds({ item, rec }));
  if (!v && !len) return "";
  /* THE EYE IS THE UNIT, for sighted readers. It is the same lens-and-pupil the
     gate's show-password toggle draws, so it is a shape already in this app
     rather than a new one — two paths, which is all that survives at 13px.
     It is aria-hidden and the WORD goes in the accessible name instead: an icon
     is not a label. Singular matters there and only there, because 0 never
     reaches this function and a compacted value is never 1. */
  const eye = `<svg class="ico-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      ><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
  return `<span class="meta-facts">`
    + (v ? `<span class="lib-stat lib-views">${eye}${escapeHtml(v)}<span class="sr-only"> ${
        views === 1 ? "view" : "views"}</span></span>` : "")
    + (len ? `<span class="lib-stat lib-len"><span class="sr-only">Length </span>${escapeHtml(len)}</span>` : "")
    + `</span>`;
}

/** THE WAY OUT TO THE ORIGINAL VIDEO. Off the cover and into the meta row, so
 *  the cover carries exactly one badge.
 *
 *  The accessible name is where the platform went when the chip was removed:
 *  "Open the original video on TikTok" costs no pixels and keeps the one fact
 *  the card no longer states out loud. `title` matches it for a mouse. The ↗
 *  is aria-hidden so the glyph is not read as a character on top of the name.
 *  Its hit area is CSS's problem — see .bp-open in the grid section. */
function openOriginalHtml(href, platform) {
  const where = platform && platform !== "Link" ? ` on ${platform}` : "";
  const label = `Open the original video${where}`;
  return `<a class="bp-open" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"
    title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span aria-hidden="true">↗</span></a>`;
}

/** m:ss. Rounded BEFORE the split, or a 59.7-second video reads "0:60". */
function lengthLabel(seconds) {
  const t = Math.round(Number(seconds) || 0);
  if (t <= 0) return "";
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** What a saved VIDEO is called. */
function sourceLabel(item) { return videoTitle({ item }); }
/* == end title resolution == */

// ---------- the composer ----------
// Paste a link at the foot of a brand and it becomes that brand's next script.
// A link is often worth remaking for more than one company, so the brand you
// are standing in is pre-ticked and the rest are one click away — one send,
// one library entry, a separate script per company.
let COMPOSE_FOR = null;      // Set of brand ids; null means "just this brand"

// How many scripts a NEW account may write, and the number this page shows
// before the server has told it otherwise. Four model calls each, three of them
// Opus, so this is a spend limit before it is a product rule.
// The default the database grants (lynxr_allowance.granted) is the same 25, and
// the WORKER charges against that ledger before it spends anything — that is
// the one that counts. Keep the two in step, and remember a single account can
// legitimately be granted more, which is why nothing below prints this constant
// once my_allowance() has answered.
const SCRIPT_CAP = 25;
// Counted against the allowance whether or not the creator still has it. Every
// one of these was four model calls that were actually paid for, so deleting a
// script must not hand the money back — otherwise 50 is not a limit, it is a
// limit on how many you keep. Deleted scripts go to the trash rather than
// vanishing, so this is just "everything ever made".
//
// THIS IS THE FALLBACK NOW, NOT THE NUMBER. It counts rows in ME — the blob the
// creator owns and PATCHes whole on every save — so it can be set to anything
// from a console, and it was three separate ways around the trial. The real
// count lives in lynxr_script_charges, a table no creator can write, and
// reaches this page only through my_allowance(). Use scriptRoom()/scriptGrant()
// below rather than either of these two directly.
const scriptsUsed = () => (ME.adaptations || []).length + (ME.trash || []).length;

/* WHAT THE SERVER SAYS THIS ACCOUNT HAS SPENT.
   `null` until my_allowance() has answered once — which is also where it stays
   on a database that has not had supabase/allowance_ledger.sql applied yet (the
   RPC 404s) and on a creator who is offline. Every read falls back to the local
   count in that case, so the rail keeps working exactly as it did before rather
   than showing a blank or a zero.

   Once a real number has landed it is KEPT through a later failure: a stale
   server number is closer to the truth than the local one, which the creator
   can edit. */
let ALLOWANCE = null;                        // { used, granted } or null

/** How many more scripts this account may write, and out of how many.
    A COURTESY, not the enforcement point — the worker charges against the
    ledger before it spends anything, and refuses there. But a courtesy that
    lies to a paying creator is worse than none, so it reads the server's
    numbers whenever it has them. */
const scriptGrant = () => (ALLOWANCE ? ALLOWANCE.granted : SCRIPT_CAP);
const scriptRoom = () => (ALLOWANCE
  ? Math.max(ALLOWANCE.granted - ALLOWANCE.used, 0)
  : SCRIPT_CAP - scriptsUsed());

/** Ask the server for the two numbers. Silent on failure by design: this runs
    on sign-in, after every send and on tab focus, and a creator does not need
    to be told that a counter refreshed late. */
async function refreshAllowance() {
  let r;
  try {
    r = await sbFetch("/rest/v1/rpc/my_allowance", { method: "POST", body: "{}" });
  } catch { return; }                        // RPC not applied yet, or offline
  const granted = Number(r?.granted);
  const used = Number(r?.used);
  // A half-answer is worse than no answer: keep whatever we had rather than
  // painting NaN into the rail.
  if (!Number.isFinite(granted) || !Number.isFinite(used)) return;
  ALLOWANCE = { used, granted };
  renderSide();
}

/** Which companies the pasted link is for. Links are sent from one place now,
    so there is no "current brand" to assume — the ticks are the whole answer.
    With a single company there is nothing to choose, so it is pre-ticked; with
    several, sending requires an explicit pick rather than guessing. */
function composeTargets() {
  const named = namedBrands();
  if (!COMPOSE_FOR) return named.length === 1 ? [named[0].id] : [];
  return named.filter((b) => COMPOSE_FOR.has(b.id)).map((b) => b.id);
}

function renderComposeFor() {
  const host = document.getElementById("composer-for");
  if (!host) return;
  // Only NAMED brands are offered. A half-made brand used to appear here as a
  // tickable "Untitled brand" chip, which is an invitation to pick something
  // that cannot be written for. With none of them named there is nothing to
  // choose between, and the send produces the video's original script.
  const named = namedBrands();
  if (!named.length) { host.innerHTML = ""; return; }
  const on = new Set(composeTargets());
  // "Write for", not "write it for": there is no "it" yet at this point — the
  // composer below is still empty, so the label referred to a video the
  // creator has not pasted.
  host.innerHTML = `<span class="lbl">Write for</span>` + named.map((b) => `
    <button type="button" class="for-chip${on.has(b.id) ? " on" : ""}" data-bid="${escapeHtml(b.id)}"
      aria-pressed="${on.has(b.id)}">
      <span class="tick" aria-hidden="true">✓</span>${escapeHtml(b.name || "Untitled brand")}
    </button>`).join("");

  host.querySelectorAll(".for-chip").forEach((chip) => chip.addEventListener("click", () => {
    const next = new Set(composeTargets());
    const id = chip.dataset.bid;
    if (next.has(id)) next.delete(id); else next.add(id);
    // An empty set is a real state now: untick everything and sending refuses,
    // rather than silently guessing a brand for you.
    COMPOSE_FOR = next;
    renderComposeFor();
    // renderComposeFor() rebuilds the whole row, so the chip just pressed no
    // longer exists — a keyboard user ticking three brands would otherwise
    // make three round-trips from the top of the document. Re-find it by
    // data-bid and put focus back where the press landed.
    document.querySelector(`.for-chip[data-bid="${CSS.escape(id)}"]`)?.focus();
  }));
}

function wireComposer() {
  const input = document.getElementById("composer-url");
  const badge = document.getElementById("composer-plat");
  // The composer only exists while the New script view is rendered. Without
  // this guard the top-level call below threw on every page load — and because
  // it threw at module scope, every statement after it (including the
  // confirmation-link handler) silently never ran.
  if (!input || !badge) return;
  const showPlat = () => {
    const u = normalizeUrl(input.value);
    const plat = u ? platformOf(u) : null;
    // Say no while they are still typing, not on submit. The badge already sits
    // in the paste field and is where the eye is, so an unsupported link reads
    // as refused before anyone reaches for the button.
    badge.textContent = u ? (plat || "not supported") : "";
    badge.className = "bp-plat" + (u ? (plat ? " on" : " on bad") : "");
  };
  input.addEventListener("input", showPlat);

  document.getElementById("composer-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = (input.value || "").trim();
    if (!raw) { say("Paste a video link first.", "bad"); input.focus(); return; }
    const url = normalizeUrl(raw);
    if (!url) { say("That doesn't look like a video link.", "bad"); input.select(); return; }

    // Refuse an off-platform link BEFORE the cap check and before any library
    // entry exists. The worker enforces the same allowlist — this row belongs to
    // the creator, so the console can walk around anything decided here — but
    // this is the one that explains itself.
    if (!platformOf(url)) {
      const h = hostOf(url);
      say(`lynxr only reads ${SUPPORTED_LIST} links`
        + (h ? ` — that one is from ${h}.` : "."), "bad");
      input.select();
      return;
    }

    // Refuse before making anything — a company created and then blocked by
    // the cap would leave an empty folder behind. scriptRoom() is the SERVER's
    // remaining allowance when my_allowance() has answered, and the local count
    // only when it has not; see its definition for why this stays a courtesy.
    const room = scriptRoom();
    if (room <= 0) {
      say(`That's all ${scriptGrant()} scripts. Ask for more from Feedback in the menu.`, "bad");
      return;
    }

    // NO COMPANY YET IS A VALID SEND (owner, 2026-08-13). Making a brand-new
    // account set a company up before it can see anything is the wall that lost
    // a live account once already. So the link goes through as-is and comes
    // back as the video's OWN script — what was said, the shots, the structure.
    // The prompt above the composer, and the card itself, then offer to rewrite
    // it for a company, which is a far easier thing to say yes to once you have
    // seen the machine work.
    if (!ME.brands.length) {
      const { item } = ensureLibraryItem(url);
      const res = queueAdaptation(item, null);
      if (!res.ok) { say(res.reason, "bad"); return; }
      input.value = "";
      showPlat();
      await save({ now: true });
      kickLiveSync?.();   // don't leave the poll idling at 60s on the send it exists to catch
      renderSide();
      // The Library is where it lands, same as any other send — the entry is
      // already there with its "writing" chip. LAND ON THE ORIGINAL SCRIPTS
      // TAB, not on whatever was open last: in "By brand" a script belonging to
      // no brand can only appear in the loose block under every named group,
      // which is where it goes to be missed. What you just asked for should be
      // the first thing on screen.
      /* ALL VIDEOS, not Original scripts (owner, 2026-08-18: "bring me to the
         all videos tab with it expanded"). This supersedes the 2026-08-17
         landing but does not undo what it fixed: that decision existed because
         "By brand" cannot show a company-less script at all, and All videos
         renders one card per video with every script under it, so the original
         is fully visible here. One word to revert. */
      LIB_MODE = "all";
      FOCUS_LID = item.id;
      go({ kind: "library" });
      landOnSend(item.id, [res.id]);
      say("Reading it now — you'll get the video's own script.", "good");
      return;
    }

    // composeTargets() only ever returns NAMED brands, so an unnamed one can no
    // longer be ticked-by-default and then block the send. That combination —
    // one brand, no name — used to be a dead end: auto-ticked, then refused for
    // having no name, with no way through and no prompt explaining it.
    const targets = composeTargets().map(brandById).filter(Boolean);

    // Nothing ticked means one of two very different things.
    if (!targets.length) {
      // They HAVE brands worth writing for and picked none — ask.
      if (namedBrands().length) {
        say("Tick which brand this is for.", "bad");
        return;
      }
      // They have no usable brand at all, so send an ORIGINAL SCRIPT: the
      // video's own words, shots and structure, with no rewrite. This is a
      // real result, not a fallback for a failure.
      if (room <= 0) {
        say(`That's all ${scriptGrant()} scripts. Ask for more from Feedback in the menu.`, "bad");
        return;
      }
      const { item: solo } = ensureLibraryItem(url);
      const res = queueAdaptation(solo, null);
      if (!res.ok) {
        say("You've already got the original script from that video.", "bad");
        return;
      }
      input.value = "";
      showPlat();
      await save({ now: true });
      kickLiveSync?.();
      renderSide();
      renderComposeFor();
      say("On it — reading the video for its original script.", "good");
      LIB_MODE = "all";        // same reason as the no-brand branch above
      FOCUS_LID = solo.id;
      go({ kind: "library" });
      landOnSend(solo.id, [res.id]);
      return;
    }

    // Ticking four companies is four scripts, so the cap has to be checked
    // against the number of TARGETS rather than the number of sends.
    if (targets.length > room) {
      say(`That's ${targets.length} scripts and you have ${room} left of ${scriptGrant()}. `
        + `Untick ${targets.length - room} to send it.`, "bad");
      return;
    }

    // One library entry however many companies it is written for.
    const { item } = ensureLibraryItem(url);
    const queued = [], skipped = [], queuedIds = [];
    for (const target of targets) {
      const res = queueAdaptation(item, target);
      (res.ok ? queued : skipped).push(target.name || "that brand");
      if (res.ok) queuedIds.push(res.id);
    }
    if (!queued.length) {
      say(skipped.length === 1
        ? `You've already got a ${skipped[0]} script from that video.`
        : `Already scripted for ${listOf(skipped)}.`, "bad");
      return;
    }
    input.value = "";
    showPlat();
    await save({ now: true });
    kickLiveSync?.();
    renderSide();
    renderComposeFor();

    const msg = `On it — ${listOf(queued)} ${queued.length > 1 ? "scripts are" : "script is"} being written.`
      + `${skipped.length ? ` (${listOf(skipped)} already had one.)` : ""}`;

    // ALL VIDEOS, not whatever was open last: By brand renders the same video
    // once per brand ticked, where All videos renders one card per video — the
    // shape a batch send needs to land on.
    LIB_MODE = "all";
    FOCUS_LID = item.id;

    // Sending from the New script page moves you to the Library, where the new
    // entry is already sitting with its "writing your script" chip and its
    // estimate. Staying on an emptied composer would look like nothing
    // happened — the confirmation belongs next to the thing it created.
    if (VIEW.kind === "new") {
      go({ kind: "library" });
      landOnSend(item.id, queuedIds);
      flashMsg("lib-flash", msg, "good");
    } else {
      paintLibraryList();
      focusLibraryEntry({ scroll: true });
      say(msg, "good");
    }
    hydrate(item);
  });
}

// ---------- source metadata ----------
async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}

/* READING A COMPANY'S WEBSITE ----------------------------------------------
   Ported from the agency app, which has done this since launch. Asking a
   creator to WRITE a description of someone else's product is asking the wrong
   person: they make videos, they do not own the positioning, and what they type
   in a hurry is worse than what the company already says about itself on its
   own homepage. So we read the homepage instead.

   Two relays because neither is reliable alone, and a browser cannot fetch a
   third-party page directly. Both are already allowed by this page's CSP. */
async function readViaAllOrigins(url) {
  const raw = await fetchWithTimeout(
    "https://api.allorigins.win/get?url=" + encodeURIComponent(url), 20000);
  const wrapped = JSON.parse(raw);
  const code = wrapped.status?.http_code;
  if (code && code >= 400) throw new Error("site returned " + code);
  return parseSiteHtml(wrapped.contents || "");
}

async function readViaCodetabs(url) {
  return parseSiteHtml(await fetchWithTimeout(
    "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url), 20000));
}

async function readCompanySite(url) {
  try { return await readViaAllOrigins(url); }
  catch { return await readViaCodetabs(url); }
}

/** DOMParser never executes scripts in the parsed document, so a hostile page
    cannot run anything here — it is inert markup by the time we read it. */
function parseSiteHtml(html) {
  if (!html || html.length < 200) throw new Error("empty read");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const meta = (sel) => doc.querySelector(sel)?.getAttribute("content") || "";
  return {
    title: (doc.querySelector("title")?.textContent || meta('meta[property="og:title"]')).trim(),
    description: (meta('meta[name="description"]') || meta('meta[property="og:description"]')).trim(),
    headings: [...doc.querySelectorAll("h1, h2, h3")]
      .map((h) => h.textContent.trim().replace(/\s+/g, " "))
      .filter((t) => t.length >= 2 && t.length <= 80),
    text: (doc.body?.textContent || "").replace(/\s+/g, " "),
  };
}

const SITE_NICHES = {
  "Health & Medical": ["health", "med", "clinic", "care", "nurse", "nursing", "doctor", "dental",
    "pharm", "therap", "wellness", "patient", "hospital", "mental", "derm", "vet", "surgery", "emt"],
  "Education & Study": ["edu", "study", "learn", "school", "course", "tutor", "academy", "exam",
    "student", "univers", "class", "teach", "lesson", "quiz", "flashcard"],
  "Fitness": ["fit", "gym", "workout", "train", "muscle", "yoga", "pilates", "run", "athlet",
    "nutrition", "strength", "cardio"],
  "Music & Audio": ["music", "audio", "sound", "song", "beat", "podcast", "guitar", "piano",
    "band", "record", "studio", "vocal", "mix"],
  "Finance & Fintech": ["financ", "fintech", "bank", "invest", "money", "crypto", "trading",
    "loan", "credit", "wealth", "tax", "budget", "payment", "payroll", "insur"],
  "Dating & Relationships": ["dating", "date", "match", "love", "relationship", "single",
    "couple", "romance", "marriage"],
  "Productivity & Apps": ["app", "productiv", "task", "note", "todo", "calendar", "workflow",
    "focus", "habit", "organiz", "planner", "remind"],
  "Marketing & Business": ["market", "agency", "brand", "growth", "seo", "ads", "advert",
    "ecommerce", "shopify", "business", "consult", "sales", "crm", "b2b"],
  "Tech & Software": ["tech", "software", "dev", "code", "coding", "ai", "data", "cloud", "api",
    "platform", "cyber", "engineer", "saas", "robot"],
  "Lifestyle & Entertainment": ["lifestyle", "travel", "food", "recipe", "fashion", "beauty",
    "game", "gaming", "entertain", "movie", "style", "home", "pet"],
};

/** Name, what it is, and a niche — everything brand_digest() needs, taken from
    the company's own words rather than the creator's guess. */
function analyzeCompanySite(read, url) {
  const hay = (read.title + " " + read.description + " " +
    read.headings.join(" ") + " " + read.text.slice(0, 20000)).toLowerCase();

  let best = null, bestScore = 0;
  for (const [niche, words] of Object.entries(SITE_NICHES)) {
    let score = 0;
    for (const w of words) {
      const count = hay.split(w).length - 1;
      if (count) score += w.length * Math.min(count, 5);
    }
    if (score > bestScore) { bestScore = score; best = niche; }
  }

  // The <title> is usually "Brand — tagline"; the first segment is the name.
  let name = (read.title || "").split(/[|–—:·]/)[0].trim();
  if (!name || name.length > 40) {
    try { name = new URL(url).hostname.replace(/^www\./, "").split(".")[0]; } catch { name = ""; }
  }

  // The meta description is the company's own one-line pitch. Failing that,
  // the first real heading — which is what a homepage leads with.
  const desc = read.description
    || read.headings.find((h) => h.split(" ").length >= 3 && h.length <= 120)
    || "";

  return { name, description: desc.slice(0, 300), niche: best || "" };
}

/** "medceptor.com", "https://x.co/y" -> a URL. Anything else -> null, and we
    treat what they typed as a plain company name. */
function asUrl(raw) {
  const s = (raw || "").trim();
  if (!s || /\s/.test(s)) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(s)) return "https://" + s;
  return null;
}

/** Instagram never publishes a bare caption. It wraps the SAME text in
    boilerplate on both og tags, in two different shapes:

      og:title        Stephanie | Study Tips on Instagram: "<caption>"
      og:description  862K likes, 1,699 comments - stephyapps on <date>: "<caption>"

    Neither one IS a title; both CONTAIN one. Lifting the quoted span out is
    what makes an Instagram row read like the TikTok row beside it, which
    arrives from oEmbed as the bare caption already.

    Matched against those two shapes specifically rather than "text after a
    colon". A caption can legitimately contain `said: "no"`, and a YouTube
    title can legitimately contain a colon at all ("How to cook: the basics") —
    a looser rule saws both in half. Measured on a live reel: og:title 233
    chars, og:description 258, identical caption inside each. */
function unwrapCaption(s) {
  const t = String(s || "").replace(/\s+$/, "");
  if (!t) return "";
  const m = t.match(/\bon (?:Instagram|Threads)\s*:\s*["“”](.*)$/s)
    || t.match(/\bon\s+\w+\s+\d{1,2},\s*\d{4}\s*:\s*["“”](.*)$/s);
  // The closing quote may be followed by a full stop and trailing space.
  if (m) return m[1].replace(/["“”][\s.]*$/, "").trim();
  return t.replace(/^[\d.,]+[KM]?\s*likes?,\s*[\d.,]+[KM]?\s*comments?\s*[-–—]\s*/i, "").trim();
}

/** A dead, private or mistyped link does not 404 — it redirects to the
    platform's own landing page, whose og:title is the product name. That is not
    a caption, and letting it through titles the row "TikTok - Make Your Day",
    which is worse than the URL it replaced because every dead link then looks
    identical. Measured with an invalid TikTok id: both relays returned exactly
    that string, and the creator regex read "TikTok" as the handle. Rejecting it
    leaves the caption empty, so sourceLabel() falls back to "TikTok video". */
const PLATFORM_BOILERPLATE =
  /^(tiktok(\s*-\s*make your day)?|instagram|youtube|login\s*[•·|]\s*instagram|instagram photos and videos|before you continue to youtube)$/i;

function metaFromHtml(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const meta = (s) => doc.querySelector(s)?.getAttribute("content") || "";
  const og = meta('meta[property="og:title"]') || doc.querySelector("title")?.textContent || "";
  const desc = meta('meta[property="og:description"]');
  // og:description carries the @handle that og:title leaves out — it names the
  // ACCOUNT ("stephyapps") where og:title gives the display name ("Stephanie").
  const handle = (og.match(/@([A-Za-z0-9._]+)/) || [])[1]
    || (desc.match(/[-–—]\s*([A-Za-z0-9._]+)\s+on\s+\w+\s+\d/) || [])[1] || "";
  // Same preference order as before — description, then title — so the only
  // behaviour that changes is the unwrapping.
  const caption = unwrapCaption(desc) || unwrapCaption(og) || og;
  // Both fields go together: the same landing page that supplies a product
  // name as the caption supplies "TikTok" as the handle.
  if (PLATFORM_BOILERPLATE.test(caption.trim())) return { caption: "", creator: "" };
  return {
    caption,
    creator: handle || (og.match(/^([^\s(|·]+)/) || [])[1] || "",
  };
}

/** Three routes, tried in order, because no single one covers every platform.
    YouTube answers its own oEmbed with CORS headers. TikTok's oEmbed refuses
    plenty of callers outright (400, no CORS header) and Instagram publishes no
    keyless oEmbed at all, so both fall through to a read-only proxy scraping
    the page's og: tags — the same two relays app.js uses, in the same order,
    because allorigins is more reliable and codetabs is the spare. */
async function fetchSourceMeta(url) {
  const oembed = /tiktok\.com/.test(url)
    ? "https://www.tiktok.com/oembed?url=" + encodeURIComponent(url)
    : /youtube\.com|youtu\.be/.test(url)
    ? "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url)
    : null;
  if (oembed) {
    try {
      const d = JSON.parse(await fetchWithTimeout(oembed, 15000));
      if (d && d.title) {
        return {
          caption: String(d.title),
          creator: String(d.author_name || d.author_unique_id || "").replace(/^@/, ""),
        };
      }
    } catch { /* fall through to the proxies */ }
  }
  /* allorigins is asked for /raw, not /get, on purpose. /get wraps the page in
     a JSON envelope, and measured against a live Instagram reel that envelope
     came back TRUNCATED — HTTP 200, 74KB, an unterminated string — so
     JSON.parse threw and discarded og tags we had ALREADY downloaded. The
     caption was sitting in those bytes. /raw returns the HTML itself (350KB,
     no envelope), so there is nothing that can half-arrive.

     Asked twice because the failures are intermittent upstream 522s rather
     than refusals: over three tries /raw carried the caption twice and timed
     out once, while /get was unusable 3 times out of 3. codetabs stays as the
     spare, though it was answering 522 itself when this was measured. */
  const relays = [
    "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
    "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
    "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url),
  ];
  let best = null;
  for (const relay of relays) {
    try {
      const meta = metaFromHtml(await fetchWithTimeout(relay, 20000));
      // A relay that answers with an error page parses fine and yields nothing.
      // Keep trying rather than returning that as the answer.
      if (meta.caption) return meta;
      best = best || meta;
    } catch { /* next relay */ }
  }
  return best || { caption: "", creator: "" };
}

/** Best-effort, fired after the card is already on screen: saving stays instant
    and the entry gets its proper name a second later. A failure is silent — an
    un-hydrated card reads fine, so a red message would be noise. */
async function hydrate(item) {
  if (realTitle(item.title) && item.caption) return;
  let meta;
  try { meta = await fetchSourceMeta(item.url); }
  catch { return; }
  const live = ME.library.find((l) => l.id === item.id);
  if (!live) return;                            // removed while the request was out
  live.caption = live.caption || meta.caption || "";
  live.creator = live.creator || meta.creator || "";
  live.title = realTitle(live.title)
    || (meta.caption || "").replace(/\s+/g, " ").trim().slice(0, 90);
  // Trash too. A deleted script keeps its own copy of the title, and only the
  // live list was ever updated — so a trashed entry held the old URL fallback
  // for good, which is exactly what the Trash view was rendering.
  for (const a of [...ME.adaptations, ...(ME.trash || [])]) {
    if (a.libraryId === live.id && live.title) a.title = live.title;
  }
  save();
  const editing = document.activeElement
    && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (!editing) { renderSide(); renderPane(); }   // titles land in both views
}

/* hydrate() only ever ran at send time, so an entry whose relays were down that
   minute stayed unnamed for good — and every Instagram entry saved before the
   /raw fix is in exactly that state. The Library asks again for anything still
   untitled, which is what turns an old `instagram.com/reels/...` row into its
   caption without the creator re-pasting anything.

   One at a time, and tracked in a session Set rather than a flag on the record:
   a relay round-trip measured 4-13s, so twenty entries firing at once would
   stall behind each other; and hydrate() re-renders on success, which calls
   back into here — the Set is what stops that becoming a loop, while still
   letting a NEXT visit retry the ones that failed, since these failures are
   intermittent 522s rather than permanent. */
/* id -> attempts, not a plain Set, because ONE failure must not be final.
   fetchSourceMeta already tries three relays, but allorigins answered 522 on
   roughly a third of measured calls, so a first sweep reliably leaves a couple
   of entries unnamed — and marking them tried meant they sat on "Instagram
   post" until a reload. Two passes: everything once, then whatever is still
   unnamed. Bounded, so a genuinely dead link cannot loop. */
const HYDRATE_TRIED = new Map();
const HYDRATE_PASSES = 2;
let HYDRATING = false;

/** Name a SCRIPT straight from its own source URL.

    hydrate() works through the Library, which is the right route while a
    library entry exists — but a trashed script can outlive the entry it was
    made from (delete the video, keep the bin), and then there is nothing left
    to hydrate and the row sits on "Instagram post" for good. This asks for the
    caption directly and writes it onto the record itself.

    Matched on canonical URL, not id, so one lookup names every sibling script
    of the same video at once — the same link scripted for three brands is
    three records here. */
async function hydrateScript(rec) {
  const url = rec.sourceUrl || "";
  if (!url) return;
  let meta;
  try { meta = await fetchSourceMeta(url); } catch { return; }
  const title = (meta.caption || "").replace(/\s+/g, " ").trim().slice(0, 90);
  if (!title) return;

  const canon = canonUrl(url);
  for (const a of [...(ME.adaptations || []), ...(ME.trash || [])]) {
    if (a.sourceUrl && canonUrl(a.sourceUrl) === canon && !realTitle(a.title)) a.title = title;
  }
  const item = (ME.library || []).find((l) => l.canon === canon);
  if (item) {
    item.title = realTitle(item.title) || title;
    item.caption = item.caption || meta.caption || "";
    item.creator = item.creator || meta.creator || "";
  }
  save();
  const editing = document.activeElement
    && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (!editing) { renderSide(); renderPane(); }
}

async function hydrateStale() {
  if (HYDRATING) return;
  HYDRATING = true;
  const tries = (id) => HYDRATE_TRIED.get(id) || 0;
  const note = (id) => HYDRATE_TRIED.set(id, tries(id) + 1);
  try {
    // Pass 1 names everything it can; pass 2 picks up whatever a flaky relay
    // dropped. Anything still unnamed after that is left for the next visit.
    for (let pass = 1; pass <= HYDRATE_PASSES; pass++) {
      for (;;) {
        // Library entries first: hydrate() fills caption and creator too, which
        // the card bodies show, where a script record only carries a title.
        const item = ME.library.find((l) => !realTitle(l.title) && tries(l.id) < pass);
        if (item) { note(item.id); await hydrate(item); continue; }
        // Then anything the Library cannot reach — chiefly trashed scripts whose
        // library row is gone, which is every "Instagram post" row in the bin.
        const rec = [...(ME.adaptations || []), ...(ME.trash || [])]
          .find((a) => a.sourceUrl && !realTitle(a.title) && tries(a.id) < pass);
        if (!rec) break;
        note(rec.id);
        await hydrateScript(rec);
      }
    }
  } finally { HYDRATING = false; }
}

// ---------- scripts ----------

/** Still being written.
 *
 *  The worker claims an adaptation before it spends anything, flipping it
 *  "queued" -> "running" so two triggers firing at once can't both process it.
 *  To a creator that distinction is invisible and should stay that way: both
 *  states mean "we're on it". Every status test in this file goes through here
 *  rather than comparing to "queued", which would drop a claimed script out of
 *  the counts and render it as neither waiting nor ready. */
function isWriting(a) {
  return a.status === "queued" || a.status === "running";
}

/* WHAT A CREATOR ACTUALLY WAITS FOR — and it is not what it used to be.

   The old estimate counted five-minute polling passes, because back when
   GitHub Actions wrote the scripts the poll interval dwarfed everything: the
   cron fired roughly every three hours, so the wait was queue, not work, and
   "about 7 minutes" was the honest floor.

   The worker now probes every 2 seconds. Polling has stopped mattering, and
   the wait is very nearly just the work — measured at 48s, 55s and 60s end to
   end. So the model inverts: count SCRIPTS AHEAD, not passes.

   These are only the fallbacks. Once an account has finished a few scripts,
   measuredWorkSec() uses its own real timings instead — the same pipeline is
   slower on a shared Fly vCPU than on an M-series Mac, and no constant written
   here would know that. */
const POLL_SEC = 2;       // worker probe interval
const LATE_SEC = 90;      // grace before admitting something has gone wrong
/* THE FALLBACK BAND, FROM TWO REAL PHONE PASTES (2026-08-17): 56s warm
   and 105s cold. A single number cannot describe that, and a countdown
   built on one would run out in front of the creator on every cold run —
   which is worse for retention than saying nothing. So: a range until
   this account has its own history, then this account's own observed
   median and max. */
const ETA_LO = 50, ETA_HI = 110;
const ETA_MIN_HISTORY = 5;   // finished scripts before we trust an account's own numbers
/* SECONDS STILL TO GO once a phase is known, from the warm run's per-stage
   split (download 2.7 + transcribe 8.0 + cover 0.3 | frames 1.0 + shots/tags
   16.6 | format 8.1 | adapt 16.7). The remaining-time distribution is much
   tighter than the whole-run one, which is why a point estimate is honest
   here and dishonest at the top. */
const PHASE_LEFT = { reading: 45, watching: 27, structure: 19, writing: 17 };
const PHASE_WORDS = {
  reading: "reading the video",
  watching: "watching it",
  structure: "finding the format",
  writing: "writing your script",
};
const PHASE_ORDER = ["reading", "watching", "structure", "writing"];
// Scripts ahead of this one in THIS account's queue, plus this one, divided
// by how many the worker takes per pass. Ticking two companies is one wave,
// not two scripts' worth of waiting: process_group runs their adaptations
// concurrently off one shared source pass.
const WORKER_BATCH = 2;   // keep in step with --max-per-creator

// Only a defensive fallback for measuredWorkSec()'s empty-list case below,
// which etaFor() never reaches in practice — it only calls measuredWorkSec()
// once hasEtaHistory() is already true. Kept so that function's own body
// needs no change.
const WORK_SEC = 60;

/** The median seconds a script really takes on this account, newest first.

    attemptedAt -> processedAt is the WORK, with the queue wait excluded —
    addedAt would fold in however long it sat behind other scripts and would
    inflate every future estimate with one bad afternoon. */
function measuredWorkSec() {
  const recent = (ME.adaptations || [])
    .filter((a) => a.status === "done" && a.attemptedAt && a.processedAt)
    .slice(0, 10)                    // adaptations are newest-first
    .map((a) => (new Date(a.processedAt) - new Date(a.attemptedAt)) / 1000)
    // Drop the impossible and the stalled: a sub-3s "script" is a failed run
    // recorded as done, and anything past 15 minutes is a wedged pass, not a
    // duration worth promising anyone.
    .filter((s) => s > 3 && s < 900)
    .sort((x, y) => x - y);
  return recent.length ? recent[Math.floor(recent.length / 2)] : WORK_SEC;
}

/** The max of the same finished-script durations measuredWorkSec() medians —
    the worst that has actually happened on this account lately, not a
    formula. */
function measuredMaxSec() {
  const recent = (ME.adaptations || [])
    .filter((a) => a.status === "done" && a.attemptedAt && a.processedAt)
    .slice(0, 10)
    .map((a) => (new Date(a.processedAt) - new Date(a.attemptedAt)) / 1000)
    .filter((s) => s > 3 && s < 900);
  return recent.length ? Math.max(...recent) : ETA_HI;
}

/** Whether this account has finished enough scripts to trust its own numbers
    over the fallback band. */
function hasEtaHistory() {
  const recent = (ME.adaptations || [])
    .filter((a) => a.status === "done" && a.attemptedAt && a.processedAt)
    .slice(0, 10)
    .map((a) => (new Date(a.processedAt) - new Date(a.attemptedAt)) / 1000)
    .filter((s) => s > 3 && s < 900);
  return recent.length >= ETA_MIN_HISTORY;
}

/** Seconds -> something a person would say out loud, for the whole-run band. */
function etaWords(secs) {
  if (secs <= 75) return "about a minute";
  if (secs < 150) return "about two minutes";
  return `about ${Math.round(secs / 60)} minutes`;
}

/** Seconds -> something a person would say out loud, for TIME LEFT in a
    phase. Deliberately not etaWords(): that rounds everything under 75s to
    "about a minute", which would erase the progress this exists to show. */
function secWords(n) {
  const s = Math.max(5, Math.round(n));
  if (s < 60) return `${s} seconds`;
  const mins = Math.round(s / 60);
  return mins === 1 ? "a minute" : `${mins} minutes`;
}

/** Everything of this creator's still waiting, oldest first — the same order
    the worker now uses, so position here is position there. */
function writingQueue() {
  return ME.adaptations.filter(isWriting)
    .sort((a, b) => String(a.addedAt || "").localeCompare(String(b.addedAt || "")));
}

function etaFor(a) {
  /* A send the server has never acknowledged is NOT queued — no worker can see
     it, so no amount of waiting will produce a script. Saying "it's picked up
     whenever the worker next runs" to someone in this state is the exact lie
     that cost a creator 25 minutes on 2026-08-17. The outbox is already
     retrying; what this has to do is stop promising a queue position that does
     not exist. */
  if (!landed(a)) {
    return {
      late: true,
      text: "Still on this device — your connection dropped on the way out. Retrying automatically; leave this page open.",
      phase: null, step: 0, steps: PHASE_ORDER.length,
    };
  }
  const pos = writingQueue().findIndex((x) => x.id === a.id);
  const ahead = pos < 0 ? 0 : pos;
  // Ticking two brands is one wave, not two scripts' worth of waiting — see
  // WORKER_BATCH above.
  const waves = Math.ceil((ahead + 1) / WORKER_BATCH);
  const hist = hasEtaHistory();
  const lo = hist ? measuredWorkSec() : ETA_LO;   // raw band low, not wave-scaled
  const hi = hist ? measuredMaxSec() : ETA_HI;    // raw band high, not wave-scaled
  const phase = PHASE_ORDER.includes(a.phase) ? a.phase : null;
  const step = phase ? PHASE_ORDER.indexOf(phase) + 1 : 0;
  const steps = PHASE_ORDER.length;
  const waited = a.addedAt ? (Date.now() - new Date(a.addedAt).getTime()) / 1000 : 0;
  // The band's high end, not the median — a normal cold run must not trip the
  // overrun wording just because it landed on the slow side of typical.
  const est = hi * waves;
  // Overdue is worth saying out loud. Silently showing an estimate to someone
  // who has been waiting well past it is how a pilot loses trust.
  if (waited > est + LATE_SEC) {
    const mins = Math.max(1, Math.round(waited / 60));
    const text = phase
      ? `Still ${PHASE_WORDS[phase]} — longer than usual…`
      : `Taking longer than usual — sent ${mins} minute${mins === 1 ? "" : "s"} ago. Still queued; it's picked up whenever the worker next runs.`;
    return { late: true, text, phase, step, steps };
  }
  if (phase) {
    const left = Math.max(5, PHASE_LEFT[phase] + (waves - 1) * hi);
    return { late: false, text: `${PHASE_WORDS[phase]} · about ${secWords(left)} left`, phase, step, steps };
  }
  return { late: false, text: `usually ${Math.round(lo * waves)}–${Math.round(hi * waves)} seconds`, phase, step, steps };
}

/* The loader, the phase and the estimate as one block. Two callers —
   the send overlay and adaptationHtml's writing branch — and one
   definition, because two copies of a progress indicator will disagree
   the first time either is touched. `stage` is HTML already safe to drop
   in as-is (any user data inside it, e.g. a brand name, is escaped by the
   caller) — this only escapes eta.text, which it builds itself. */
function etaBlockHtml(a, stage) {
  /* THE SKELETON ONLY. Everything here is a function of the record, never of
     elapsed time — the estimate, the late marker and which segments are lit are
     written by paintEta() and by nothing else. That split is what lets the poll
     update a waiting card without rebuilding the pane around it, and it is what
     makes the two impossible to drift apart: there is only one writer.
     The rail ships all four segments and starts `hidden`, so a block that never
     reaches paintEta() shows no rail rather than four dead bars. */
  return `<div class="loader" role="status" aria-live="polite" data-eta="${escapeHtml(a.id)}">
      ${loaderMark()}
      <div class="loader-text">
        <div class="loader-stage">${stage}</div>
        <div class="loader-sub bp-eta"></div>
        <div class="eta-rail" aria-hidden="true" hidden>${
          PHASE_ORDER.map(() => `<i class="eta-seg"></i>`).join("")}</div>
      </div>
    </div>`;
}

/* FILL IN EVERY PROGRESS BLOCK ON SCREEN, IN PLACE.
   The only thing that moves without the data moving is the estimate, the
   overdue warning and how much of the rail is lit — so those are the only three
   things this writes, straight onto the nodes already on the page. Rebuilding
   the pane for them is what destroyed and recreated every <details> in it every
   2.5 seconds, which collapsed whatever the creator had expanded.

   Idempotent and cheap — a handful of nodes — so it is safe to call after every
   render and again on every poll. That redundancy is deliberate: a block whose
   render site forgot to call it is filled by the next tick instead of staying
   blank forever.

   The textContent guard is not cosmetic: .loader carries aria-live="polite",
   and writing the identical string back would make a screen reader re-announce
   the estimate every 2.5 seconds. */
function paintEta(root = document) {
  if (!root) return;
  root.querySelectorAll(".loader[data-eta]").forEach((el) => {
    const a = (ME.adaptations || []).find((x) => x.id === el.dataset.eta);
    if (!a) return;
    const eta = etaFor(a);
    const sub = el.querySelector(".bp-eta");
    if (sub) {
      if (sub.textContent !== eta.text) sub.textContent = eta.text;
      sub.classList.toggle("bp-partial", !!eta.late);
    }
    const rail = el.querySelector(".eta-rail");
    if (rail) {
      rail.hidden = !(eta.step > 0);
      [...rail.querySelectorAll(".eta-seg")].forEach((seg, i) =>
        seg.classList.toggle("on", i < eta.step));
    }
  });
}

/** Companies that do NOT already have a script from this source video. */
function brandsWithout(item) {
  const taken = new Set(libScripts(item).filter((a) => a.status !== "error").map((a) => a.brandId));
  return ME.brands.filter((b) => !taken.has(b.id) && (b.name || "").trim());
}

/** Queue the same saved video for more companies, from wherever it's shown.
    This is the whole point of the library holding one entry per video: a
    source worth remaking is usually worth remaking for more than one client,
    and re-pasting the link to do it was busywork.

    This is the ONLY cap check queueAdaptation() itself doesn't make — the
    composer submit handler enforces SCRIPT_CAP on its own two paths (2374,
    2423), but both entry points here (the Library's + Brand chips and
    ad-brandify) called straight into queueAdaptation with nothing stopping
    them, which could push an account past 50 from the browser. Refuse the
    whole call rather than partially queueing some of `brandIds`, matching the
    composer's own "not enough room for all of them" refusal at 2427-2431 —
    that one doesn't trim either.

    Returns what it queued and what it skipped so the caller can re-enable
    whatever UI it disabled and choose its own message — this function has no
    view of what that control is. */
async function alsoWriteFor(item, brandIds, afterRender) {
  const room = scriptRoom();
  if (room <= 0) {
    say(`That's all ${scriptGrant()} scripts. Ask for more from Feedback in the menu.`, "bad");
    return { queued: [], skipped: [] };
  }
  if (brandIds.length > room) {
    say(`That's ${brandIds.length} scripts and you have ${room} left of ${scriptGrant()}. `
      + `Untick ${brandIds.length - room} to send it.`, "bad");
    return { queued: [], skipped: [] };
  }
  const queued = [], skipped = [];
  for (const id of brandIds) {
    const co = brandById(id);
    if (!co) continue;
    (queueAdaptation(item, co).ok ? queued : skipped).push(co.name || "that company");
  }
  if (!queued.length) return { queued, skipped };
  await save({ now: true });
  kickLiveSync?.();
  renderSide();
  if (afterRender) afterRender();
  return { queued, skipped };
}

/** The one place a saved video becomes a queued script. Caller saves. */
/** `co` may be null: a creator with no company yet still gets the video read
    and its own script handed back. The worker treats a missing brandId as a
    finished job rather than an error, and stops before the rewrite. */
function queueAdaptation(item, co) {
  /* ONE SCRIPT PER VIDEO PER BRAND. No exceptions and no `force` escape hatch:
     the parameter existed for "run it again", which is gone, and leaving it in
     meant a single caller could quietly reintroduce duplicates — which is
     exactly how the same video ended up with two scripts for one brand.

     A video with no brand (co === null) is treated the same way, keyed on
     brandId null, so the original script cannot be produced twice either.
     `status !== "error"` is what lets a failed read be retried: a script that
     never arrived is not a duplicate of anything. */
  const dupe = ME.adaptations.find((a) => (a.brandId || null) === (co ? co.id : null)
    && a.status !== "error"
    && a.sourceUrl && canonUrl(a.sourceUrl) === item.canon);
  if (dupe) {
    return { ok: false, id: dupe.id,
             reason: isWriting(dupe)
               ? "That one's already being written — it'll appear here."
               : co ? `You've already got a ${co.name || "brand"} script from that video.`
                    : "You've already got that video's script." };
  }
  const id = newId();
  ME.adaptations.unshift({
    id, libraryId: item.id, sourceUrl: item.url,
    brandId: co ? co.id : null,
    brandName: co ? (co.name || "Untitled brand") : "",
    // ONLY a real caption is stored. sourceLabel() used to be written here,
    // which froze "Instagram reel" onto the record when the caption had not
    // loaded yet — and a stored label reads as a real title to every test in
    // this file. The label is derived at paint time now (videoTitle), so an
    // empty string here is correct and heals on its own.
    title: realTitle(item.title),
    status: "queued", addedAt: new Date().toISOString(),
    code: trackCode(co ? co.name : "LYNX"),   // spec §6.2 / R3 — issued at brief time
  });
  return { ok: true, id };
}

// Status at last paint, so a script that finishes while the page is open
// announces itself instead of quietly swapping a chip.
const SEEN = new Map();
const FLASH = new Set();

/* WHICH SCRIPTS ARE OPEN FOR EDITING. Ids only — the edits themselves live in
   the textareas until Save, so Cancel is simply a re-render and needs no undo
   buffer. Not persisted: a half-finished edit should not survive a reload as a
   silent draft nobody remembers making. */
const EDITING = new Set();

/** The script, as fields you can change.
 *
 *  Editing is plain textareas over the same shape the model returns — hook,
 *  a row per beat, cta, caption — rather than a rich editor, because what a
 *  creator actually wants to fix is a word choice or a line that does not sound
 *  like them. Nothing here calls the API: this is the creator's own writing, it
 *  costs nothing, and it cannot fail.
 *
 *  Beats keep their SAY / DO / SHOW split rather than collapsing to one box.
 *  Flattening them would lose which line is spoken and which is an instruction,
 *  and scriptText() and the Copy button both read those fields by name.
 */
/** Read every open textarea back onto the adaptation.
 *
 *  Called before ANY re-render that must not lose what is typed — Save, and
 *  also adding or removing a beat, since those rebuild the list from the data
 *  and would otherwise discard edits made to the other beats first. */
function stashEdits(host, a) {
  const scope = host.querySelector(`.ed[data-adid="${CSS.escape(a.id)}"]`);
  if (!scope || !a.adaptation) return;
  const beats = Array.isArray(a.adaptation.beats)
    ? a.adaptation.beats.map((b) => ({ ...b })) : [];
  scope.querySelectorAll(".ed-input").forEach((el) => {
    const v = el.value.trim();
    if (el.dataset.beat === undefined) { a.adaptation[el.dataset.field] = v; return; }
    const b = beats[Number(el.dataset.beat)];
    if (b) b[el.dataset.field] = v;
  });
  a.adaptation.beats = beats;
}

function scriptEditor(a, ad, silent) {
  const id = escapeHtml(a.id);
  const beats = Array.isArray(ad.beats) ? ad.beats : [];
  const field = (label, name, value, rows) => `
    <label class="ed-field"><span class="lbl">${label}</span>
      <textarea class="ed-input grow" rows="${rows || 1}" data-adid="${id}"
        data-field="${name}">${escapeHtml(value || "")}</textarea></label>`;
  return `
    <div class="ed" data-adid="${id}">
      ${field(silent ? "Opening card" : "Hook", "hook", ad.hook, 2)}
      <div class="bp-heading">${silent ? "Shots" : "Beats"}</div>
      <ol class="ed-beats">${beats.map((b, i) => `
        <li class="ed-beat">
          <span class="ed-n">${i + 1}</span>
          <div class="ed-beat-fields">
            ${silent ? "" : `
            <label class="ed-field"><span class="lbl">say</span>
              <textarea class="ed-input grow" rows="1" data-adid="${id}"
                data-beat="${i}" data-field="say">${escapeHtml(b.say || "")}</textarea></label>`}
            <label class="ed-field"><span class="lbl">do</span>
              <textarea class="ed-input grow" rows="1" data-adid="${id}"
                data-beat="${i}" data-field="do">${escapeHtml(b.do || "")}</textarea></label>
            <label class="ed-field"><span class="lbl">show</span>
              <textarea class="ed-input grow" rows="1" data-adid="${id}"
                data-beat="${i}" data-field="show">${escapeHtml(b.show || "")}</textarea></label>
          </div>
          ${/* Removing a beat is the one structural edit worth having — a
                script that runs one beat too long is the commonest fix, and
                without this the only way to shorten it is a rewrite. */""}
          <button type="button" class="ghost danger icon-only ed-drop" data-adid="${id}"
            data-beat="${i}" aria-label="Remove this beat" title="Remove this beat">
            <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>
          </button>
        </li>`).join("")}</ol>
      <button type="button" class="linkish ed-add" data-adid="${id}">+ add a beat</button>
      ${field(silent ? "Final card" : "CTA", "cta", ad.cta, 1)}
      ${field("Caption", "caption", ad.caption, 2)}
    </div>`;
}

function beatRow(bt, carry, silent) {
  let say = (bt.say || "").trim();
  let doIt = (bt.do || "").trim();
  let show = (bt.show || "").trim();
  // Collapsing repeats keeps a spoken script readable — the words are the
  // point and an unchanged shot is still running. A silent video is the
  // opposite: DO and SHOW *are* the script, and blanking them would drop the
  // beat entirely, so every beat is printed in full and nothing is dimmed.
  if (carry && !silent) {
    const wasDo = doIt, wasShow = show;
    if (doIt && doIt === carry.do) doIt = "";
    if (show && show === carry.show) show = "";
    carry.do = wasDo || carry.do;
    carry.show = wasShow || carry.show;
  }
  /* Each row carries its TYPE as a class. SAY, DO and SHOW are three different
     instructions — words to speak, an action to perform, literal text to put on
     screen — and they were rendering identically in silent scripts, where `dim`
     is false for both DO and SHOW. A wall of same-weight text with a 9.5px
     label as the only distinction is unreadable at a glance, and these are read
     while filming. */
  const row = (label, v, dim) => v
    ? `<span class="bp-lbl bp-lbl-${label.toLowerCase()}">${label}</span><span class="bp-val bp-${label.toLowerCase()}${dim ? " bp-dim" : ""}">${escapeHtml(v)}</span>`
    : "";
  // No timing column. These are recreation beats, not a cut list — the order
  // is the instruction, and "0-4s" invited people to match a stopwatch to a
  // video they are deliberately not copying shot for shot. The `t` values are
  // still stored. (The agency blueprints still show theirs: they annotate a
  // specific existing video, where the timestamp is the point. Hence the
  // scoped .bp-notime class rather than editing the shared .bp-beat grid.)
  // SPOKEN scripts are SAY and DO only. SHOW was a third line to read on every
  // beat when the words are the thing you came for, and it mostly restated the
  // hook as an on-screen caption. It is still extracted and stored — nothing
  // downstream loses it — it just isn't in the way.
  //
  // SILENT scripts keep it, because there it IS the script: `say` is empty by
  // design on every beat, and dropping SHOW would leave a shot list with the
  // actual content missing.
  const rows = [row("SAY", say), row("DO", doIt, !silent),
                silent ? row("SHOW", show, false) : ""].filter(Boolean);
  if (!rows.length) return "";
  return `<li class="bp-beat">${rows.join("")}</li>`;
}

function scriptText(a) {
  const ad = a.adaptation || {};
  const quiet = ad.delivery === "silent"
    || (Array.isArray(ad.beats) && ad.beats.length && ad.beats.every((b) => !(b.say || "").trim()));
  const lines = [`${a.brandName || "Script"} — from ${a.sourceUrl || ""}`, ""];
  if (quiet) lines.push("NO VOICEOVER — shot by shot, the SHOW lines go on screen.", "");
  if (ad.hook) lines.push(`${quiet ? "OPENING CARD" : "HOOK"}: "${ad.hook}"`, "");
  for (const b of ad.beats || []) {
    if (b.say) lines.push(`  SAY:  ${b.say}`);
    if (b.do) lines.push(`  DO:   ${b.do}`);
    if (quiet && b.show) lines.push(`  SHOW: ${b.show}`);   // matches the card: silent only
  }
  if (ad.cta) lines.push("", `${quiet ? "FINAL CARD" : "CTA"}: ${ad.cta}`);
  if (ad.caption) lines.push("", `CAPTION: ${ad.caption}`);
  return lines.join("\n");
}

/** THE ORIGINAL AS SECTIONS, off data the record already carries.
 *  Costs nothing: source.shots and source.script.segments were grafted onto
 *  this record by the worker and are already in memory. Nothing is fetched,
 *  nothing is queued, no allowance is spent.
 *  Shots are the section markers — they are the only per-moment VISUAL fact
 *  stored — and transcript segments file under the shot whose window they
 *  start in. Both carry real seconds: shots[].t is the ffmpeg seek that
 *  produced the frame, segments are Whisper's [start, end, text]. */
function refSections(a) {
  const src = a.source || {};
  const segs = (Array.isArray((src.script || {}).segments) ? src.script.segments : [])
    .filter((s) => Array.isArray(s) && s.length >= 3)
    .map(([st, , txt]) => ({ t: Number(st) || 0, text: String(txt || "").trim() }))
    .filter((s) => s.text)
    .sort((x, y) => x.t - y.t);
  const shots = (Array.isArray(src.shots) ? src.shots : [])
    .filter(Boolean)
    .map((s) => ({ t: Number(s.t) || 0, visual: String(s.visual || "").trim(),
                   text: String(s.onscreen_text || "").trim() }))
    .sort((x, y) => x.t - y.t);
  if (!segs.length && !shots.length) return [];
  // NO SHOTS: one section per spoken line, which is exactly the timed
  // transcript the Original scripts tab already draws. Folding them into a
  // single section would turn a script into a paragraph.
  if (!shots.length) return segs.map((s) => ({ t: s.t, visual: "", text: "", says: [s.text] }));
  const secs = [];
  // Speech BEFORE the first frame gets its own opening section. Measured: one
  // live row has its first frame at 4.7s, so 4.7 seconds of words would
  // otherwise be filed under a direction that had not happened yet.
  if (segs.length && segs[0].t < shots[0].t - 0.05) {
    secs.push({ t: segs[0].t, visual: "", text: "", says: [] });
  }
  for (const sh of shots) secs.push({ t: sh.t, visual: sh.visual, text: sh.text, says: [] });
  for (const sg of segs) {
    let i = secs.length - 1;
    while (i > 0 && secs[i].t > sg.t + 0.05) i--;
    secs[i].says.push(sg.text);
  }
  return secs.filter((s) => s.visual || s.text || s.says.length);
}

/** "Frames were read up to 0:09 of 1:33." — a FACT, drawn only when it is
 *  needed. analyze_visuals.frame_times() takes the first six Whisper segment
 *  starts, so on a talky video every frame lands in the opening seconds:
 *  measured across the 23 videos in the 2026-08-23 backup the shot list
 *  covers a median 60% of the video and under half of it on 10 of 23. Without
 *  this line the panel would imply the video ends where the directions do. */
function refFramesNote(a) {
  const shots = (a.source || {}).shots || [];
  if (!Array.isArray(shots) || !shots.length) return "";
  const last = Math.max(...shots.map((s) => Number(s.t) || 0));
  const dur = videoSeconds({ rec: a });
  if (!(dur > 0) || last >= dur * 0.8) return "";
  return `Frames were read up to ${lengthLabel(last)} of ${lengthLabel(dur)}.`;
}

/** THE PANEL ITSELF — the original's sections, rendered beside/under the
 *  script inside the same card. Returns "" when there is nothing to show
 *  (refSplitHtml then leaves the script exactly as it was).
 *  `data-refid`, never `data-adid`: wireAdaptationCards enrols
 *  `details.bp-item[data-adid]` in the one-script-open-at-a-time rule, and
 *  this panel must open ALONGSIDE the script, not instead of it — the same
 *  decision `.lib-orig` records for its `data-oid`.
 *  `class="bp-item ref-panel"` on purpose: it inherits the caret rotation,
 *  the bp-open/bp-close reveal and wireDisclosureMotion's close animation
 *  for free — no new motion is introduced.
 *  `open` is always emitted; openDisclosures/restoreDisclosures (below)
 *  preserve whatever the creator does to it across a repaint. */
function referenceHtml(a) {
  const secs = refSections(a);
  if (!secs.length) return "";
  const src = a.source || {};
  const cover = thumbHtml(
    coverUrl({ libraryId: a.libraryId, canon: canonUrl(a.sourceUrl || "") }),
    entryLabel(a), a.sourceUrl);
  const note = refFramesNote(a);
  const noSpeechHint = !(src.script || {}).has_speech && Array.isArray(src.shots) && src.shots.length
    ? `<p class="bp-hint">No speech &mdash; this one is carried by what's on screen.</p>` : "";
  const secsHtml = secs.map((sec) => `
      <li class="ref-sec">
        <span class="ref-t">${escapeHtml(lengthLabel(sec.t) || "0:00")}</span>
        <div class="ref-sec-body">
          ${sec.visual ? `<p class="ref-do">${escapeHtml(sec.visual)}</p>` : ""}
          ${sec.text ? `<p class="ref-text">“${escapeHtml(sec.text)}”</p>` : ""}
          ${sec.says.length ? `<p class="ref-say">${escapeHtml(sec.says.join(" "))}</p>` : ""}
        </div>
      </li>`).join("");
  return `<details class="bp-item ref-panel" open data-refid="${escapeHtml(a.id)}">
    <summary>
      <span class="bp-caret" aria-hidden="true">▸</span>
      <span class="bp-name">The original</span>
    </summary>
    <div class="bp-body">
      <div class="ref-head">${cover}${note ? `<p class="ref-note">${escapeHtml(note)}</p>` : ""}</div>
      ${noSpeechHint}
      <ol class="ref-secs">${secsHtml}</ol>
      <div class="bp-actions">
        <button type="button" class="ghost ad-copy" data-adid="${escapeHtml(a.id)}" data-ref="1">Copy</button>
      </div>
    </div>
  </details>`;
}

/** The script, with the original beside it when there is one to show.
 *  Returns the script UNCHANGED when the record carries no source — an
 *  errored entry, or one written before the worker stored a shot list. The
 *  card then looks exactly as it does today; an empty panel would read as a
 *  broken one. Measured on the 2026-08-23 backup: 5 of 47 records carry no
 *  `source` at all. */
function refSplitHtml(a, scriptHtml) {
  const ref = referenceHtml(a);
  if (!ref) return scriptHtml;
  return `<div class="ref-split"><div class="ref-main">${scriptHtml}</div>${ref}</div>`;
}

/** THE VIDEO'S OWN WORDS, for the clipboard. scriptText() above builds from
 *  `a.adaptation`, which is the BRAND REWRITE — so it was the wrong function
 *  for an original card in both of that card's shapes: on a branded record
 *  borrowed by the Original scripts tab it copied the brand script under a
 *  "<BrandName> — from <url>" header, and on a genuine no-brand record
 *  (`a.adaptation` absent) it copied a header line and nothing else.
 *  Reads only `a.source`, the same place adaptationHtml's asOriginal branch
 *  reads, so what is copied is what is on screen.
 *  Source casing is preserved on purpose — lowercase is a text-transform in
 *  app.css and must never reach a clipboard. */
function originalText(a) {
  const src = a.source || {};
  const segs = Array.isArray((src.script || {}).segments) ? src.script.segments : [];
  const shots = Array.isArray(src.shots) ? src.shots : [];
  const t = (n) => `${Math.round(Number(n) || 0)}s`;
  const lines = [`Original — from ${a.sourceUrl || ""}`, ""];
  if (segs.length) {
    lines.push("WHAT THEY SAY", "");
    for (const [st, , txt] of segs) lines.push(`  ${t(st)}  ${String(txt || "").trim()}`);
  } else {
    lines.push("No speech — this one is carried by what's on screen.");
  }
  if (shots.length) {
    lines.push("", "WHAT'S ON SCREEN", "");
    for (const sh of shots) {
      lines.push(`  ${t(sh.t)}  ${sh.visual || ""}`);
      if ((sh.onscreen_text || "").trim()) lines.push(`          “${sh.onscreen_text.trim()}”`);
    }
  }
  return lines.join("\n");
}

/** THE PANEL'S OWN CLIPBOARD TEXT — plain text in the SAME section order the
 *  panel paints, per originalText()'s own docstring contract ("what is
 *  copied is what is on screen"): the panel is a different screen from the
 *  one originalText() serves, so it gets its own function rather than a
 *  second wording jammed into that one. Does not modify originalText() —
 *  that one is still the Original scripts tab's Copy button.
 *  Source casing is preserved on purpose, same reason as originalText(). */
function referenceText(a) {
  const secs = refSections(a);
  const lines = [`Original — from ${a.sourceUrl || ""}`];
  const note = refFramesNote(a);
  if (note) lines.push(note);
  lines.push("");
  const t = (n) => lengthLabel(n) || "0:00";
  secs.forEach((sec, i) => {
    if (i) lines.push("");
    lines.push(`  ${t(sec.t)}  ${sec.visual || ""}`.replace(/\s+$/, ""));
    if (sec.text) lines.push(`        “${sec.text}”`);
    if (sec.says.length) lines.push(`        ${sec.says.join(" ")}`);
  });
  return lines.join("\n");
}

/* ---------- THE TELEPROMPTER ----------

   Reading a script off a phone means looking at the middle of the screen, and
   the front camera is at the TOP — so the footage shows someone reading, eyes
   visibly off-axis. Everything here exists to close that gap: the reading band
   is pinned to the top of the viewport, right under the lens, and the controls
   are pushed to the bottom where a thumb can reach them without the hand
   crossing the frame.

   It scrolls at a constant rate, the way a real teleprompter does — varying
   speed per beat is unreadable. What the beats DO supply is the finish line:
   `t` ("0-3s", "3-7s") gives the video's intended length, so the scroll is
   paced to end when the video should. A generic teleprompter has to ask for a
   words-per-minute setting; this one already knows.

   No recording here, deliberately. That is a much heavier feature — camera
   permissions, codec support, the mirrored-preview/unmirrored-output trap, and
   somewhere to put the file — and the reading half is useful on its own. */

/* SHELVED — turn this back on with one line.

   The whole feature is built and works (beat-timed scroll, 3-2-1 countdown,
   full-bleed camera, mirrored preview against an unmirrored recording), but it
   is parked while the app stays focused on the one job it launched to do: send
   a link, get a script. Flipping this to true restores the button on every
   script card; nothing else has to change.

   Kept rather than deleted deliberately — this is a fair amount of measured
   behaviour (the reading band's position, the pacing derived from `t`, the
   preview/recording mirror split) that would be expensive to rediscover. */
const TP_ENABLED = false;

const TP = { raf: 0, y: 0, playing: false, pxPerSec: 0, last: 0, lock: null };
const TP_PREFS = "lynxr.prompter";
// Speaking pace when a script carries no usable `t` values. 140 wpm is an
// unhurried piece-to-camera; the creator can trim it live with the − / + keys.
const TP_WPM = 140;

function tpPrefs() {
  try { return JSON.parse(localStorage.getItem(TP_PREFS)) || {}; } catch { return {}; }
}
function tpSavePrefs(p) {
  try { localStorage.setItem(TP_PREFS, JSON.stringify(p)); } catch { /* private mode */ }
}

/** The video's intended length, from the beats' own `t` ranges. 0 when the
    script predates `t` or the values don't parse — the caller falls back to
    counting words. */
function scriptSeconds(ad) {
  let end = 0;
  for (const b of (ad.beats || [])) {
    const t = String(b.t || "");
    const span = t.match(/(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)/);
    if (span) { end = Math.max(end, parseFloat(span[2])); continue; }
    const one = t.match(/(\d+(?:\.\d+)?)/);
    if (one) end = Math.max(end, parseFloat(one[1]));
  }
  return end;
}

/** What actually gets read aloud, in order. A spoken script reads its `say`
    lines with `do` beside them as a dim stage direction; a silent one has no
    `say` at all, so the `show` cards become the script — the same swap the
    card and the copied text already make. `show` is never surfaced on a spoken
    script: it is text for the EDIT, not for the mouth, and putting it in the
    reading lane invites people to say it out loud. */
function prompterLines(ad, silent) {
  const out = [];
  if (ad.hook) out.push({ kind: silent ? "card" : "hook", text: String(ad.hook).trim(), cue: "" });
  for (const b of (ad.beats || [])) {
    const words = String((silent ? b.show : b.say) || "").trim();
    const cue = String(b.do || "").trim();
    if (words) out.push({ kind: silent ? "card" : "say", text: words, cue });
    else if (cue) out.push({ kind: "cue", text: "", cue });
  }
  if (ad.cta) out.push({ kind: silent ? "card" : "cta", text: String(ad.cta).trim(), cue: "" });
  return out.filter((l) => l.text || l.cue);
}

function tpEl(id) { return document.getElementById(id); }

function openPrompter(a) {
  const ad = a && a.adaptation;
  const wrap = tpEl("tp");
  if (!ad || !wrap) return;
  const silent = ad.delivery === "silent"
    || (Array.isArray(ad.beats) && ad.beats.length && ad.beats.every((b) => !(b.say || "").trim()));
  const lines = prompterLines(ad, silent);
  if (!lines.length) return;

  const scroll = tpEl("tp-scroll");
  scroll.innerHTML = lines.map((l) => `<div class="tp-line tp-${l.kind}">
      ${l.text ? `<span class="tp-words">${escapeHtml(l.text)}</span>` : ""}
      ${l.cue ? `<span class="tp-cue">${escapeHtml(l.cue)}</span>` : ""}
    </div>`).join("");
  tpEl("tp-brand").textContent = a.brandName || "your script";

  const p = tpPrefs();
  applyTpSize(p.size || 34);
  TP.speed = p.speed || 1;

  wrap.hidden = false;
  document.body.classList.add("modal-open");

  /* Rate is measured AFTER the overlay is visible: a hidden element has no
     layout, so scrollHeight would be 0 and every script would scroll instantly.
     Two frames — one for the unhide, one for the font metrics to settle. */
  /* Parked at the top, NOT playing. Opening the prompter is when you get the
     phone into position and read the first line — if the script starts moving
     on open, the take is already behind you before you have framed yourself.
     Nothing scrolls until the record button is pressed. */
  requestAnimationFrame(() => requestAnimationFrame(() => {
    tpMeasure(ad, lines);
    tpSeek(0);
    tpPlay(false);
  }));
  tpWakeLock();
  /* Camera up front, before the script moves. Two reasons: you cannot frame a
     shot you cannot see, and asking for the permission HERE means the prompt
     is answered while nothing is happening — request it at record time instead
     and the "allow camera" dialog lands on top of the 3-2-1, so the countdown
     runs out while the creator is still tapping it. Refused or absent, this
     quietly stays a teleprompter. */
  tpCamera();
}

/** px/sec such that the script finishes when the video should. */
function tpMeasure(ad, lines) {
  const scroll = tpEl("tp-scroll");
  const band = tpEl("tp-band");
  // The run is the text plus one band-height of lead-out, so the last line
  // travels up to the reading position instead of stopping at the bottom edge.
  TP.run = Math.max(1, scroll.scrollHeight + band.clientHeight * 0.6);
  let secs = scriptSeconds(ad);
  if (!secs) {
    const words = lines.reduce((n, l) => n + (l.text ? l.text.split(/\s+/).length : 0), 0);
    secs = Math.max(4, (words / TP_WPM) * 60);
  }
  TP.pxPerSec = TP.run / secs;
  TP.secs = secs;
  tpEl("tp-len").textContent = `${Math.round(secs)}s`;
}

function applyTpSize(px) {
  // CSSOM, not a style attribute — style-src is 'self' with no 'unsafe-inline',
  // so an inline style attribute here is silently dropped.
  tpEl("tp-scroll").style.fontSize = `${px}px`;
  TP.size = px;
}

function tpSeek(y) {
  TP.y = Math.max(0, Math.min(y, TP.run || 0));
  tpEl("tp-scroll").style.transform = `translate3d(0, ${-TP.y}px, 0)`;
}

function tpPlay(on) {
  TP.playing = on;
  const btn = tpEl("tp-play");
  if (btn) {
    // aria-pressed ONLY — CSS swaps the two faces off it. Never write
    // textContent here: it would replace both svgs with a word and the button
    // would degrade to text permanently (the armDelete bug).
    btn.setAttribute("aria-pressed", String(on));
    // The same button records when there is a camera and merely scrolls when
    // there is not, so it has to say which it is about to do. Calling it
    // "Pause" while it is stopping a take would be a lie about what happens.
    const rec = !!REC.stream;
    const label = on ? (rec ? "Stop recording" : "Pause")
                     : (rec ? "Start recording" : "Play");
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
  }
  cancelAnimationFrame(TP.raf);
  if (!on) return;
  TP.last = 0;
  const step = (ts) => {
    if (!TP.playing) return;
    if (TP.last) tpSeek(TP.y + TP.pxPerSec * TP.speed * ((ts - TP.last) / 1000));
    TP.last = ts;
    if (TP.y >= (TP.run || 0)) { tpPlay(false); return; }   // reached the end
    TP.raf = requestAnimationFrame(step);
  };
  TP.raf = requestAnimationFrame(step);
}

function tpSpeed(mult) {
  TP.speed = Math.max(0.4, Math.min(2.5, Math.round(mult * 10) / 10));
  tpEl("tp-rate").textContent = `${TP.speed.toFixed(1)}×`;
  tpSavePrefs({ ...tpPrefs(), speed: TP.speed });
}

/* A phone that sleeps mid-take is the one failure that costs a whole
   performance, so hold the screen awake while the prompter is up. Progressive
   enhancement — unsupported browsers just behave as before. */
async function tpWakeLock() {
  try { TP.lock = await navigator.wakeLock.request("screen"); } catch { TP.lock = null; }
}

/* ---------- RECORDING ----------

   The centre button is one control with two jobs, because on a phone they are
   the same moment: hit record and the script starts moving. Splitting them
   would mean pressing play, then reaching for record while already on camera.

   Nothing is uploaded. The recording is held in memory and handed to the
   device — hosting creator footage means storage cost, upload waits, and a far
   heavier privacy posture than the video LINKS this app deals in today. */

const REC = { stream: null, rec: null, chunks: [], on: false, url: "", counting: false, timer: 0 };

/* iOS Safari and Chrome disagree on container support, and an unsupported
   mimeType throws rather than falling back. Ask, in order of preference, and
   let the browser choose if it likes none of them. */
function recMime() {
  const want = ["video/mp4;codecs=h264,aac", "video/mp4",
                "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const m of want) {
    try { if (window.MediaRecorder?.isTypeSupported?.(m)) return m; } catch { /* keep looking */ }
  }
  return "";
}

async function tpCamera() {
  if (REC.stream) return true;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return false;
  try {
    REC.stream = await navigator.mediaDevices.getUserMedia({
      /* ASK FOR 9:16, not just big numbers. width/height alone are treated as
         a size hint and phones happily answer a portrait request with their
         native LANDSCAPE sensor mode — 1280x720 — which then has to be cropped
         to fit a tall screen. That crop is what reads as squished, and it also
         means the preview is showing a different frame from the one being
         recorded. aspectRatio is the constraint that actually asks for the
         shape; short-form is 9:16, so that is what to film in. */
      video: {
        facingMode: "user",
        aspectRatio: { ideal: 9 / 16 },
        width: { ideal: 1080 },
        height: { ideal: 1920 },
      },
      audio: true,
    });
  } catch { return false; }               // denied, or no camera on this device
  const v = tpEl("tp-cam");
  v.srcObject = REC.stream;
  v.play().catch(() => { /* autoplay policy — the stream still records */ });
  tpEl("tp").classList.add("tp-live");
  tpFitCamera();
  return true;
}

/** Make the preview the exact shape of the thing being recorded.

    A camera may refuse the 9:16 request and hand back whatever it has. If that
    happens the preview must not silently pretend otherwise: the creator frames
    the shot against what they can see, so a preview shaped differently from the
    file is how you end up with a head cropped out of the top of every take.
    Reads the REAL track settings and stamps that ratio on the element (CSSOM —
    a style attribute would be dropped by style-src 'self'). */
function tpFitCamera() {
  const v = tpEl("tp-cam");
  const track = REC.stream?.getVideoTracks?.()[0];
  if (!v || !track) return;
  const apply = () => {
    const s = (track.getSettings && track.getSettings()) || {};
    const w = s.width || v.videoWidth;
    const h = s.height || v.videoHeight;
    if (!w || !h) return;
    v.style.aspectRatio = `${w} / ${h}`;
    // Portrait-ish stream: it can fill the screen with only a sliver cropped,
    // which is what "camera fills the screen" should mean. A landscape stream
    // cropped to a phone's shape loses most of the frame, so letterbox it and
    // show the truth instead — the creator can see the shape is wrong and turn
    // the phone, rather than discovering it in the exported file.
    v.classList.toggle("tp-cam-wide", w / h > 1);
  };
  apply();
  // videoWidth is 0 until the first frame decodes, so settle it again then.
  v.addEventListener("loadedmetadata", apply, { once: true });
}

/** 3 … 2 … 1. Resolves false if the creator pressed stop while it ran. */
function tpCountdown(from) {
  const el = tpEl("tp-count");
  return new Promise((done) => {
    let n = from;
    REC.counting = true;
    el.hidden = false;
    const tick = () => {
      if (!REC.counting) { el.hidden = true; done(false); return; }
      if (n === 0) { el.hidden = true; REC.counting = false; done(true); return; }
      el.textContent = String(n);
      n -= 1;
      REC.timer = setTimeout(tick, 1000);
    };
    tick();
  });
}

async function tpStartRecording() {
  const hasCam = await tpCamera();
  // No camera, or permission refused: fall back to being a plain teleprompter
  // rather than refusing to do anything. Reading the script is the part that
  // always works.
  if (!hasCam) { tpSeek(0); tpPlay(true); return; }

  tpPlay(false);
  tpSeek(0);
  if (!(await tpCountdown(3))) return;    // cancelled mid-count

  REC.chunks = [];
  const mime = recMime();
  try {
    REC.rec = new MediaRecorder(REC.stream, mime ? { mimeType: mime } : undefined);
  } catch { REC.rec = new MediaRecorder(REC.stream); }
  REC.rec.ondataavailable = (e) => { if (e.data && e.data.size) REC.chunks.push(e.data); };
  REC.rec.onstop = tpFinishRecording;
  REC.rec.start();
  REC.on = true;
  tpEl("tp").classList.add("tp-rec");
  tpPlay(true);                            // script and camera start together
}

function tpStopRecording() {
  // Cancel a countdown that has not finished — pressing stop during "3, 2, 1"
  // should abandon the take, not queue one up.
  if (REC.counting) {
    REC.counting = false;
    clearTimeout(REC.timer);
    tpEl("tp-count").hidden = true;
    return;
  }
  tpPlay(false);
  tpEl("tp").classList.remove("tp-rec");
  REC.on = false;
  try { REC.rec?.state !== "inactive" && REC.rec?.stop(); } catch { /* already stopped */ }
}

/** The take is done. Hand it to the device — never to a server. */
function tpFinishRecording() {
  if (!REC.chunks.length) return;
  const type = REC.rec?.mimeType || "video/mp4";
  if (REC.url) URL.revokeObjectURL(REC.url);
  REC.url = URL.createObjectURL(new Blob(REC.chunks, { type }));
  REC.chunks = [];
  const ext = /mp4/.test(type) ? "mp4" : "webm";
  const link = tpEl("tp-save");
  if (!link) return;
  link.href = REC.url;
  link.download = `lynxr-take.${ext}`;
  link.hidden = false;
}

/** One button, two jobs. */
function tpMainButton() {
  if (REC.on || REC.counting) { tpStopRecording(); return; }
  tpStartRecording();
}

function closePrompter() {
  const wrap = tpEl("tp");
  if (!wrap || wrap.hidden) return;
  if (REC.on || REC.counting) tpStopRecording();
  tpPlay(false);
  /* Release the camera explicitly. Hiding the overlay leaves the tracks live —
     the recording light stays on and the creator has no way to tell the app
     let go, which is the kind of thing that costs you their trust exactly
     once. Stop every track, then drop the element's reference to the stream. */
  for (const t of (REC.stream?.getTracks() || [])) { try { t.stop(); } catch { /* gone */ } }
  REC.stream = null;
  const cam = tpEl("tp-cam");
  if (cam) cam.srcObject = null;
  wrap.classList.remove("tp-live", "tp-rec");
  wrap.hidden = true;
  document.body.classList.remove("modal-open");
  try { TP.lock?.release(); } catch { /* already gone */ }
  TP.lock = null;
}

function initPrompter() {
  const wrap = tpEl("tp");
  // Shelved: don't wire the controls or the Escape/space key handlers at all.
  // Nothing can reach the overlay, so listening for its keys would only mean
  // the prompter quietly eating the space bar on every page.
  if (!wrap || !TP_ENABLED) return;
  tpEl("tp-close").addEventListener("click", closePrompter);
  tpEl("tp-play").addEventListener("click", tpMainButton);
  // Rewind only. Restart is what you press after a fluffed take, and that is
  // the moment you want to breathe and reset — not be read at again instantly.
  tpEl("tp-restart").addEventListener("click", () => { tpPlay(false); tpSeek(0); });
  tpEl("tp-slower").addEventListener("click", () => tpSpeed(TP.speed - 0.1));
  tpEl("tp-faster").addEventListener("click", () => tpSpeed(TP.speed + 0.1));
  const resize = (d) => {
    applyTpSize(Math.max(18, Math.min(72, TP.size + d)));
    tpSavePrefs({ ...tpPrefs(), size: TP.size });
    // The run length depends on how tall the text is, so re-measure or the
    // pacing silently drifts after a resize.
    TP.run = Math.max(1, tpEl("tp-scroll").scrollHeight + tpEl("tp-band").clientHeight * 0.6);
    TP.pxPerSec = TP.run / (TP.secs || 1);
  };
  tpEl("tp-smaller").addEventListener("click", () => resize(-3));
  tpEl("tp-bigger").addEventListener("click", () => resize(3));
  // Tapping the reading band toggles play — the controls are a thumb-stretch
  // away at the bottom, and mid-take you want the biggest possible target.
  tpEl("tp-band").addEventListener("click", () => tpPlay(!TP.playing));
  document.addEventListener("keydown", (e) => {
    if (wrap.hidden) return;
    if (e.key === "Escape") { closePrompter(); return; }
    if (e.key === " ") { e.preventDefault(); tpPlay(!TP.playing); }
    if (e.key === "ArrowUp") { e.preventDefault(); tpSeek(TP.y - 60); }
    if (e.key === "ArrowDown") { e.preventDefault(); tpSeek(TP.y + 60); }
  });
}

/* Called HERE, not up with the other module-level wiring. `TP_ENABLED` is a
   const, so calling initPrompter() before this point in the file reads it
   inside its temporal dead zone and throws — which does not fail politely:
   the exception stops creator.js mid-evaluation and every declaration below it
   is left uninitialised, taking the whole app down with it. Definition and
   call stay adjacent so they cannot drift apart again. */
initPrompter();

/** opts.open   — render already expanded. Used inside a Library entry the
 *                creator has just opened: they opened it to read the script, so
 *                a second disclosure to reach it is the step this removes.
 *  opts.nested — this card is inside a Library entry. That entry already shows
 *                the video's thumbnail and its title, so repeating both here
 *                said nothing and made one video look like two. Nested cards
 *                are labelled by what actually differs between them — the brand
 *                each was written for — and drop the thumbnail.
 */
function adaptationHtml(a, liveName, opts = {}) {
  /* `asOriginal` renders the VIDEO'S OWN script off a record that also holds a
     brand rewrite. Both live on the same record (see hasSourceScript), so the
     Original scripts tab can show the untouched transcript for a video you
     scripted for a company — without queueing anything or spending a script. */
  const { open: forceOpen = false, nested = false, bare = false,
          asOriginal = false } = opts;
  const prevSeen = SEEN.get(a.id);
  const justReady = (prevSeen === "queued" || prevSeen === "running") && a.status === "done";
  if (justReady) FLASH.add(a.id);
  SEEN.set(a.id, a.status);
  const flash = FLASH.has(a.id);
  FLASH.delete(a.id);

  const ad = a.adaptation;
  const lowFit = ad && typeof ad.fit === "number" && ad.fit < 0.45;
  // Trust the model's own `delivery`, but fall back to the beats so scripts
  // written before that field existed still render as silent when they are.
  const silent = !!ad && (ad.delivery === "silent"
    || (Array.isArray(ad.beats) && ad.beats.length
        && ad.beats.every((b) => !(b.say || "").trim())));
  /* TWO BUCKETS ON A FAILURE, because "couldn't fetch" was being shown for
     failures that had nothing to do with the fetch — a model failure on a
     video we read fine tells the creator to go and check their link. Anything
     the worker classified as a source failure keeps the fetch wording;
     everything else it named (`noteKind` is stamped by
     process_adaptations.set_note) is ours. Rows written before `noteKind`
     existed have none, so they keep today's wording rather than silently
     changing meaning.

     THE LAST ARM IS THE LEGACY-ROW FALLBACK. It is only reachable with a
     truthy `brandId` — the `!a.brandId` test sits directly above it — so what
     it describes is a BRANDED entry that finished with no script, while its
     old wording (source-only) names a no-brand ORIGINAL. That string is
     deleted from this file rather than corrected: the pipeline no longer
     writes that state at all (fill_adaptation raises instead of returning
     "done"), so the only rows that can land here are ones written before that. */
  const chip = a.status === "error"
    ? (a.noteKind && a.noteKind !== "fetch"
        ? statusChip("bad", "couldn't write", "no script")
        : statusChip("bad", "couldn't fetch", "no video"))
    : a.status !== "done" ? statusChip("bp-wait", "writing your script", "writing", true)
    : asOriginal ? statusChip("good", "original script", "original")
    : lowFit ? statusChip("", "poor fit", "")
    : ad ? statusChip("good", "script ready", "ready")
    : !a.brandId ? statusChip("good", "original script", "original")
    : statusChip("bad", "no script", "");
  const href = safeUrl(a.sourceUrl || "");
  const id = escapeHtml(a.id);
  // brandName was snapshotted when this was queued, so it goes stale the moment
  // the brand is renamed. Prefer what the brand is called now.
  const brandNow = liveName || a.brandName || "this brand";
  // The same source is usually worth remaking for more than one client, and
  // the library already holds it — so offer the other companies right here
  // rather than making the creator go and paste the link again.
  const srcItem = ME.library.find((l) => l.id === a.libraryId)
    || (a.sourceUrl ? ME.library.find((l) => l.canon === canonUrl(a.sourceUrl)) : null);
  const reuse = srcItem ? brandsWithout(srcItem) : [];

  let body;
  if (isWriting(a)) {
    /* The same mark the brand lookup uses. This is the longest wait in the app
       — a link goes off to be transcribed, watched and rewritten — and it used
       to be two lines of grey text, which reads the same whether the worker is
       running or has died. A moving mark says "still going" on its own.
       The small "writing" chips in the library lists stay as dots: a 46px
       animation inside a status chip would be noise, and those are glanced at
       rather than waited on. */
    body = etaBlockHtml(a, a.brandId
      ? `Writing it for ${escapeHtml(brandNow)}`
      : "Reading the video for its original script");
  } else if (a.status === "error") {
    /* NO RETRY BUTTON ON A WALL. `retryable: false` is written by the worker
       (see FETCH_FAILURES in process_adaptations.py) for the failures whose
       answer cannot change — age-gated, private, deleted, geo-blocked, or a
       link that was never a video. Offering Try again there sends the creator
       round a loop that fails identically every time, which is what makes a
       limitation read as a bug. Undefined counts as retryable: entries written
       before this shipped, and every model-side failure, still get the button. */
    const canRetry = a.retryable !== false;
    /* ONLY COPY THIS APP WROTE. `noteKind` is stamped by
       process_adaptations.set_note(), which takes a registry key and never
       prose — so its presence is the proof this sentence was written for a
       creator. A row written before that existed (two are sitting in live
       `trash` carrying raw yt-dlp stderr, one Restore click from a card) has
       no kind and falls back to the generic sentence, instead of painting
       "ERROR: [TikTok] 7524866777004723486: … Use --cookies-from-browser". */
    const note = a.noteKind ? a.note : "";
    body = `<p class="bp-hint bad">${escapeHtml(note || "That video couldn't be downloaded.")}</p>
      ${canRetry
        ? `<div class="bp-actions"><button type="button" class="ghost ad-retry" data-adid="${id}">Try again</button></div>`
        : ""}`;
  } else if (ad && !asOriginal) {
    const carry = { do: "", show: "" };
    const script = `
      ${/* A good score explains nothing the script itself doesn't say better, and
            it pushed the hook — the thing you came for — below the fold. Only the
            poor-fit warning still shows: that one changes what you'd do next. */""}
      ${lowFit ? `<p class="bp-hint bp-partial"><strong>This format doesn't really suit ${escapeHtml(brandNow)}.</strong>
          ${escapeHtml(ad.fit_reason || "")} The script below is written anyway, but a format that fits
          would do better than forcing this one.</p>` : ""}
      ${a.format?.name ? `<div class="chips bp-tags"><span class="chip">${escapeHtml(a.format.name)}</span>
        ${a.source?.tags?.format_type ? `<span class="chip">${escapeHtml(a.source.tags.format_type)}</span>` : ""}
        ${a.source?.tags?.hook_pattern ? `<span class="chip">${escapeHtml(a.source.tags.hook_pattern)}</span>` : ""}</div>` : ""}
      ${/* NO NOTE UNDER A DELIVERED SCRIPT. A finished entry no longer carries
            one at all (fill_adaptation writes its internal step failures to
            `diag`, which nothing renders), and the only strings this line
            could ever have painted were those internal ones — a script that
            arrived intact but whose tag call blipped showed "tags failed:
            Overloaded" beneath it. */""}
      ${EDITING.has(a.id) ? scriptEditor(a, ad, silent) : `
      ${ad.hook ? `<div class="bp-hook"><span class="bp-hook-lbl">${
        silent ? "Opening card" : "Hook"}</span>“${escapeHtml(ad.hook)}”</div>` : ""}
      ${silent ? `<p class="bp-hint">No voiceover — put the SHOW line on screen at each beat.</p>` : ""}
      ${/* Silent scripts get no heading. "Shot by shot" sat directly above a
            list of shots, under a line that already says "no voiceover — put
            the show line on screen at each beat", so it named what was
            self-evident twice over. Spoken scripts keep theirs: there the beats
            follow a hook and a delivery note, so the label marks where the
            script itself starts. */""}
      ${silent ? "" : `<div class="bp-heading">Your script</div>`}
      <ol class="bp-beats bp-notime">${(ad.beats || []).map((b) => beatRow(b, carry, silent)).join("")}</ol>
      ${ad.cta ? `<p class="bp-hint"><strong>${silent ? "Final card" : "CTA"}:</strong> ${escapeHtml(ad.cta)}</p>` : ""}
      ${ad.caption ? `<p class="bp-hint"><strong>Caption:</strong> ${escapeHtml(ad.caption)}</p>` : ""}`}
      ${/* format.why_it_works is still extracted and stored — it is useful to the
            model and to step 2's clustering — it just isn't shown. It explains the
            format to someone who already has the script, which is analysis nobody
            asked for at the bottom of the thing they came to film. */""}
      <div class="bp-actions">
        ${/* The teleprompter leads this row, and is the only labelled button
              here: copy/edit/delete are things you do TO the script, this is
              the thing you do WITH it. Named for what it shows — a silent
              script has no words to read aloud, so its SHOW lines are cue
              cards, the same rename the hook and CTA already take. */""}
        ${EDITING.has(a.id) || !TP_ENABLED ? "" : `<button type="button" class="btn ad-prompt" data-adid="${id}"
          >${silent ? "Cue cards" : "Teleprompter"}</button>`}
        ${EDITING.has(a.id) ? `
          <button type="button" class="btn ad-save" data-adid="${id}">Save changes</button>
          <button type="button" class="ghost ad-cancel" data-adid="${id}">Cancel</button>`
        : `${/* No rewrite button. Asking the model again spent another script
                from the allowance to produce a different-but-equivalent answer,
                and the pencil now covers the real need — changing a line that
                does not sound like you — for nothing. A creator who genuinely
                wants a fresh take can send the link again.

                Edit and delete sit on THIS row rather than a separate one
                below: they are things you do to this script, same as copying
                it, and a second row of buttons underneath read as a different
                kind of control. Pushed right by .bp-icons so the destructive
                one is not adjacent to the one you press most. */""}
          <span class="bp-icons">
            <button type="button" class="ghost icon-only ad-copy" data-adid="${id}"
              aria-label="Copy this script" title="Copy this script">
              <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                ><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
            </button>
            <button type="button" class="ghost icon-only ad-edit" data-adid="${id}"
              aria-label="Edit this script" title="Edit this script">
              <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                ><path d="M16.8 3.8a2.1 2.1 0 0 1 3 3L8.5 18.1l-4 1 1-4z"/><path d="M14.5 6.1l3.4 3.4"/></svg>
            </button>
            <button type="button" class="ghost danger icon-only ad-del" data-adid="${id}"
              aria-label="Delete this script" title="Delete this script">
              <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                ><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
            </button>
          </span>`}
      </div>
      ${/* NOT when nested. Inside a Library entry the entry itself already
            offers the leftover brands (see `spare` in libraryEntryHtml), and
            this block offers exactly the same list from the same source — so a
            video with one script rendered "Also write this for + scrubdaddy"
            twice, one under the other. The offer belongs to the VIDEO, which is
            what the Library entry is; a script card only owns it on a brand
            page, where there is no entry above it to carry it. */""}
      ${reuse.length && !EDITING.has(a.id) && !nested ? `<div class="bp-heading">Also write this for</div>
        <div class="chips lib-also">${reuse.map((b) => `
          <button type="button" class="chip pick ad-also" data-adid="${id}" data-bid="${escapeHtml(b.id)}"
            >+ ${escapeHtml(b.name)}</button>`).join("")}</div>` : ""}`;
    body = refSplitHtml(a, script);
  } else if (asOriginal || !a.brandId) {
    /* THE ORIGINAL SCRIPT — a finished result, not a failure.
       This branch used to be shared with "the rewrite failed", so a creator who
       asked for the original got "Read, but not written yet" and a Try again
       button that would spend another script and produce the same answer. The
       two cases are opposites and are told apart by brandId.
       `asOriginal` reaches this branch from a record that DOES have a brand
       rewrite, which is how the Original scripts tab shows the video's own
       words for a video you scripted for a company. */
    const src = a.source || {};
    const scr = src.script || {};
    const segs = Array.isArray(scr.segments) ? scr.segments : [];
    const shots = Array.isArray(src.shots) ? src.shots : [];
    const t = (n) => `${Math.round(Number(n) || 0)}s`;
    body = `
      ${a.format?.name ? `<div class="chips bp-tags"><span class="chip">${escapeHtml(a.format.name)}</span>
        ${src.tags?.format_type ? `<span class="chip">${escapeHtml(src.tags.format_type)}</span>` : ""}
        ${src.tags?.hook_pattern ? `<span class="chip">${escapeHtml(src.tags.hook_pattern)}</span>` : ""}</div>` : ""}
      ${segs.length ? `<div class="bp-heading">What they say</div>
        <ol class="bp-beats">${segs.map(([st, , txt]) => `
          <li class="bp-beat"><span class="bp-t">${escapeHtml(t(st))}</span>
            <span class="bp-lbl bp-lbl-say">SAY</span><span class="bp-val bp-say">${escapeHtml(String(txt || "").trim())}</span></li>`).join("")}</ol>`
        : `<p class="bp-hint">No speech &mdash; this one is carried by what's on screen.</p>`}
      ${/* SHOW rows are .bp-dim, SAY rows are not — the same weighting the
            agency blueprints use (row("SAY", say) plain, row("SHOW", …, true)
            dimmed) and the same one beatRow() applies to brand scripts. The
            words are what you came to read; the visuals are the annotation
            around them, and printing both in full white made the two compete.
            This branch was the one place that never got the treatment. */""}
      ${shots.length ? `<div class="bp-heading">What's on screen</div>
        <ol class="bp-beats">${shots.map((sh) => `
          <li class="bp-beat"><span class="bp-t">${escapeHtml(t(sh.t))}</span>
            <span class="bp-lbl bp-lbl-show">SHOW</span><span class="bp-val bp-show bp-dim">${escapeHtml(sh.visual || "")}${
              (sh.onscreen_text || "").trim() ? `\n“${escapeHtml(sh.onscreen_text.trim())}”` : ""}</span></li>`).join("")}</ol>` : ""}
      <div class="bp-actions">
        ${/* data-orig marks WHICH script this button copies, and it has to be
              on the BUTTON rather than looked up from the record: after this
              change the same record can render twice inside one Library card
              — once as its brand rewrite, once as the video's own words — so
              two .ad-copy buttons can carry the same data-adid and mean
              different things. See originalText. */""}
        <button type="button" class="ghost ad-copy" data-adid="${id}" data-orig="1">Copy</button>
        ${/* No rewrite here either — same reason as on a brand script. This is
              the video's own transcript, so "ask again" would return the same
              words anyway. */""}
        ${/* "Write this for a brand" turns an original INTO a brand script, so
              it makes no sense on a record that already is one — this card is
              only borrowing that record's source to show the video's own words.
              The entry's own "Also write this for" chips are the right control
              there, and they already offer the brands it is NOT written for. */""}
        ${a.brandId ? "" : `<button type="button" class="btn ad-brandify" data-adid="${id}">Write this for a brand</button>`}
      </div>`;
  } else {
    /* BRANDED, FINISHED, NO SCRIPT — an illegal state the pipeline can no
       longer write (fill_adaptation raises instead of returning "done"), kept
       as defence in depth for rows written before that landed. It used to
       print the joined internal notes: on 2026-08-18 a tester read "Read, but
       not written yet. tags failed: overloaded; format extraction failed:
       overloaded; format extraction failed: overloaded". Fixed copy now, and
       no `a.note` — there is nothing here a creator can act on except the
       retry. The allowance claim is true: lynxr_script_charges.adaptation_id
       is a primary key, so retrying the same entry cannot charge twice. */
    body = `<p class="bp-hint">We couldn't finish this one. Try again — it won't
      take anything more from your allowance.</p>
      <div class="bp-actions"><button type="button" class="ghost ad-retry" data-adid="${id}">Try again</button></div>`;
  }

  const statusClass = `bp-${isWriting(a) ? "queued" : escapeHtml(a.status)}${flash ? " bp-flash" : ""}`;
  /* A written script carries its own copy / edit / delete icons on the actions
     row inside `body`, so it gets nothing here — rendering this as well put a
     second pencil and a second trash on every card.

     The other branches (the original transcript, a failed read) have no such
     row, and still need a way to be deleted. */
  const deleteBtn = ad ? "" : `
      <div class="bp-foot">
        <button type="button" class="ghost danger icon-only ad-del" data-adid="${id}"
          aria-label="Delete this script" title="Delete this script">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            ><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
        </button>
      </div>`;

  /* BARE: no summary row at all, just the script.
     Used for the ONLY script on a Library entry. Opening the entry is already
     the decision — a second disclosure underneath it, labelled with a brand
     name the group heading above has just said, was two clicks and two labels
     for one thing. With several scripts the rows come back, because then the
     list is a genuine choice between them. */
  if (bare) {
    return `<div class="bp-item lib-bare ${statusClass}" data-adid="${id}">
      <div class="bp-body">${body}${deleteBtn}</div>
    </div>`;
  }

  /* A WRITING CARD OPENS ITSELF. `wireAdaptationCards` keeps one script open at
     a time because a finished script runs to a couple of screens — a card that
     holds nothing but a mark, a phase and an estimate is four lines, and
     collapsing it hides the only thing it has to say. Two companies sent
     together therefore show two honest clocks rather than two shut rows.
     When it finishes, `justReady` holds it open, so the script appears in the
     place the creator was already looking.

     MEASURED, 2026-08-18 (Brave 151, Chromium): `open` set in the markup was
     expected to fire no toggle event. It DOES — a <details open> inserted by
     innerHTML fires toggle on insertion — which meant the first writing card's
     own toggle ran the one-script-at-a-time handler and shut the second, so two
     companies showed one clock. That handler now exempts writing cards in both
     directions; see the comment on it. Do not re-derive this from the spec. */
  return `<details class="bp-item ${statusClass}"${justReady || forceOpen || isWriting(a) ? " open" : ""} data-adid="${id}">
    <summary>
      <span class="bp-caret" aria-hidden="true">▸</span>
      ${nested ? "" : thumbHtml((a.source || {}).cover, entryLabel(a), a.sourceUrl,
        { tile: true, kind: platformLabel(a.sourceUrl || ""), dur: lengthLabel(videoSeconds({ rec: a })) })}
      ${/* Same resolver the Trash view uses: prefers the live library entry's
            caption, falls back to the platform wording, never a permalink. */""}
      ${/* Under `asOriginal` the record's brand is irrelevant — the card is
            showing the video's own words, not that brand's rewrite — so it must
            not be labelled with the brand name. */""}
      <span class="bp-name">${escapeHtml(nested
        ? (a.brandId && !asOriginal ? brandNow : "Original script")
        : entryLabel(a))}</span>
      ${/* Nested, a green "script ready" sits next to the finished script it is
            describing, under an entry whose own chip already says ready —
            three ways of saying the same thing. Writing and error chips STAY: those
            say something the collapsed card otherwise cannot. */""}
      ${/* THE STATUS CHIP. On a tile it leads the META ROW under the title —
            the same rule that places a library card's, widened rather than
            copied. (Both comments claimed the cover until 2026-08-23; the CSS
            had moved the chip into the row long before.) Seven faces reach it
            (see `chip` above): couldn't fetch / couldn't write (red), writing
            your script (grey + dot), original script and script ready (green),
            poor fit (plain), no script (red). All of them move together, and
            no count is invented for a card that is one script. */""}
      ${nested && a.status === "done" ? "" : chip}
      ${nested ? "" : metaFactsHtml({ rec: a })}
      ${/* Same for the timestamp: the entry above carries the video's own. */""}
      ${nested ? "" : `<span class="bp-when">${escapeHtml(agoLabel(a.addedAt))}</span>`}
      ${/* The ↗ is the parent entry's link too when nested — same video, same
            URL — so it only appears on a standalone card. */""}
      ${href && !nested ? openOriginalHtml(href, platformLabel(a.sourceUrl || "")) : ""}
    </summary>
    <div class="bp-body">${body}${deleteBtn}</div>
  </details>`;
}

function renderScripts(b) {
  const host = document.getElementById("ad-list");
  if (!host) return;
  const list = brandScripts(b);
  if (!list.length) {
    /* A brand you have just finished setting up lands here, so this is the
       first thing a new creator sees after the form — "No scripts yet." alone
       named the state and left them to work out the next move. */
    host.innerHTML = `<div class="empty lib-empty">
      ${emptyDemo()}
      ${/* No explanatory line under the heading: the little animation above it
            already shows a link going in and a script coming out, and the
            button says what pressing it does. The sentence restated both. */""}
      <p><strong>No scripts yet.</strong></p>
      <div class="bp-actions"><button type="button" class="btn" id="brand-empty-cta">Create first script</button></div>
    </div>`;
    // Carries the brand through, the same way the + in the Scripts header does:
    // standing in a company is already the answer to "who is this for", so the
    // composer should not ask again. Sent with nothing ticked, an account with
    // more than one named brand met a refusal on its very first send.
    host.querySelector("#brand-empty-cta").addEventListener("click", () => {
      COMPOSE_FOR = new Set([b.id]);
      go({ kind: "new" });
    });
    return;
  }
  // Same backfill the Library and Trash run — a creator sitting on a brand
  // page never triggered it, so a standalone card could only heal by
  // visiting another view.
  hydrateStale();
  /* The bar is rendered ONCE and the grid repainted underneath it. Rebuilding
     the <input> on every keystroke is what the Library's own re-focus dance
     exists to paper over; not rebuilding it is better than repairing it. */
  host.innerHTML = `
    ${list.length >= LIB_SEARCH_AT ? findBarHtml({
      id: "ad", q: AD_Q, sort: AD_SORT, sorts: ["new", "old", "az"],
      placeholder: "search titles, hooks, captions", brief: "search scripts",
      what: "scripts",
    }) : ""}
    <div id="ad-grid"></div>`;
  wireFindBar("ad", () => paintScriptGrid(b),
    (v) => { AD_Q = v; }, (v) => { AD_SORT = v; });
  paintScriptGrid(b);
}

/** Just the grid — so a keystroke in the search box does not rebuild the box
    underneath the cursor. Same split as renderLibrary / paintLibraryList. */
function paintScriptGrid(b) {
  const host = document.getElementById("ad-grid");
  if (!host) return;
  const all = brandScripts(b);
  const q = AD_Q.trim();
  const shown = findSort(
    q ? all.filter((a) => findMatch(scriptHay(a), q)) : all,
    AD_SORT, (a) => entryLabel(a));

  const count = document.getElementById("ad-count");
  if (count) count.textContent = shown.length === all.length ? "" : `${shown.length} of ${all.length}`;

  if (!shown.length) {
    host.innerHTML = findEmptyHtml(q, "ad");
    const clear = document.getElementById("ad-clear");
    if (clear) clear.addEventListener("click", () => {
      AD_Q = "";
      const box = document.getElementById("ad-q");
      if (box) { box.value = ""; box.focus(); }
      paintScriptGrid(b);
    });
    return;
  }

  host.innerHTML = `<div class="bp-list script-grid">${
    shown.map((a) => adaptationHtml(a, b.name)).join("")}</div>`;
  wireAdaptationCards(host);
  paintEta(host);          // etaBlockHtml only ships the skeleton — see paintEta
}

/* Everything an adaptation card can do, wired against whatever host it was
   rendered into. Extracted from renderScripts because the Library renders
   cards too: an ORIGINAL script belongs to no brand, so no brand page can list
   it, and before this it was written, stored, and visible nowhere. */
/** THE SCROLLER, found rather than assumed. It is NOT the same element at every
 *  width: .pane-scroll carries overflow-y:auto, but on a phone .shell is a
 *  column with no height cap, so that box never actually scrolls
 *  (scrollHeight === clientHeight) and the DOCUMENT does — the same fact that
 *  forced .pane-head to position:static under 820px. Testing for a box that
 *  really scrolls covers both without hardcoding the breakpoint a third time. */
function scrollerFor(el) {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
  }
  return document.scrollingElement || document.documentElement;
}

/** Bring an opened card's top edge to the top of the viewport.
 *
 *  Owner, 2026-08-18: "when i open a script have it auto scroll to the top of
 *  the expanded card". It replaces a `scrollIntoView({block:"nearest"})` that
 *  only nudged a card far enough to be visible — which left the header halfway
 *  up the screen with the script running off the bottom.
 *
 *  MEASURED AFTER THE REFLOW, NEVER BEFORE. Opening a card sets
 *  `grid-column: 1 / -1` on it, which re-flows every tile after it and changes
 *  the card's own height and position; and the one-open-at-a-time handler may
 *  CLOSE a card above it in the same tick, moving it up by a whole row. A
 *  target computed at click time is wrong by more the further down the grid the
 *  card sits. Reading the rect inside rAF forces layout first, so the number is
 *  the post-open one.
 *
 *  THE STICKY HEADER IS AN OFFSET ONLY WHERE IT IS STICKY. .pane-head pins to
 *  the top on desktop and is static under 820px, so the card lands below it on
 *  one and flush to the viewport on the other. Asked of the computed style
 *  rather than of the viewport width, so it cannot drift from the CSS.
 *
 *  A card near the bottom cannot put its top at the top — there is not enough
 *  document beneath it. scrollTo clamps to the maximum on its own, which is
 *  exactly "as far as possible"; no special case, and no fight with the
 *  container. */
function scrollCardToTop(card) {
  const scroller = scrollerFor(card);
  const head = document.querySelector(".pane-head");
  const offset = head && getComputedStyle(head).position === "sticky"
    ? Math.round(head.getBoundingClientRect().height) : 0;
  const isDoc = scroller === document.scrollingElement || scroller === document.documentElement;
  const base = isDoc ? 0 : scroller.getBoundingClientRect().top;
  const top = scroller.scrollTop + card.getBoundingClientRect().top - base - offset;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  scroller.scrollTo({ top: Math.max(0, Math.round(top)), behavior: still ? "auto" : "smooth" });
}

/** Wire that scroll onto a genuine open, and onto nothing else.
 *
 *  ON CLICK, NEVER ON `toggle`. A <details open> inserted by innerHTML fires
 *  toggle on insertion — measured in this file, and the reason wireAdaptation
 *  Cards' one-at-a-time handler is written the way it is. A toggle-based
 *  version of this would yank the page every time the grid repainted: on every
 *  keystroke in the search box, on every ETA tick of a writing card, and on
 *  every restoreDisclosures() after a live-sync repaint. A click is a person.
 *  Enter and Space on a focused <summary> dispatch one too, so the keyboard is
 *  covered and the auto-opening writing card is not.
 *
 *  AND ONLY WHEN IT OPENED. The same summary click closes the card, and
 *  collapsing must leave the page exactly where it is — so the rAF re-checks
 *  `card.open` rather than assuming the click meant "open". */
function keepInView(host) {
  if (!host) return;
  host.querySelectorAll(".script-grid > details.bp-item > summary")
    .forEach((sum) => sum.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;            // the ↗ goes somewhere else
      const card = sum.parentElement;
      requestAnimationFrame(() => {
        if (card.open) scrollCardToTop(card);
      });
    }));
}

function wireAdaptationCards(host) {
  if (!host) return;
  keepInView(host);
  stopSummaryLinks(host);
  host.querySelectorAll(".ad-prompt").forEach((btn) => btn.addEventListener("click", () => {
    const a = (ME.adaptations || []).find((x) => x.id === btn.dataset.adid);
    if (a) openPrompter(a);
  }));

  /* ONE SCRIPT OPEN AT A TIME. A script runs to a couple of screens, so two
     expanded at once meant scrolling through the first to discover the second
     — and in the Library, where each entry can hold a script per brand, three
     open at once buried the page.

     Wired per-element rather than delegated: the `toggle` event does not
     bubble. Scoped to [data-adid] so it closes SCRIPTS only — the Library
     entries around them are .bp-item too, and folding those would shut the
     video you are reading inside. Assigning .open re-fires toggle on the ones
     being closed, but they exit on the !d.open guard, so there is no loop.

     WRITING CARDS ARE EXEMPT, BOTH WAYS. The rule exists because a finished
     script runs to a couple of screens. A card that is still writing holds a
     mark, a phase and an estimate — four lines — so it crowds nothing and
     closing it hides the only thing it has to say. Measured 2026-08-18: a
     <details open> inserted by innerHTML DOES fire toggle on insertion, so
     without this exemption the first writing card's own toggle shut the second
     one, and two companies sent together showed one clock instead of two. */
  const cards = [...host.querySelectorAll("details.bp-item[data-adid]")];
  const writing = (el) => {
    const a = (ME.adaptations || []).find((x) => x.id === el.dataset.adid);
    return !!(a && isWriting(a));
  };
  cards.forEach((d) => d.addEventListener("toggle", () => {
    if (!d.open) return;
    if (writing(d)) return;            // a clock opening must not shut your script
    cards.forEach((other) => {         // and your script opening must not shut a clock
      if (other !== d && !writing(other)) other.open = false;
    });
  }));

  host.querySelectorAll(".ad-copy").forEach((btn) => btn.addEventListener("click", async () => {
    const a = ME.adaptations.find((x) => x.id === btn.dataset.adid);
    if (!a) return;
    try {
      await navigator.clipboard.writeText(
        btn.dataset.ref ? referenceText(a)
        : btn.dataset.orig ? originalText(a) : scriptText(a));
      /* Swap the ICON, not the text. This button used to say "Copy script" and
         confirmed by setting textContent — which on an icon button replaces the
         svg with a word and leaves it permanently wrong, because the restore
         put the old label back rather than the drawing. Remember innerHTML,
         show a tick, put the drawing back. */
      const face = btn.innerHTML;
      btn.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M20 6L9 17l-5-5"/></svg>`;
      btn.classList.add("ok");
      setTimeout(() => { btn.innerHTML = face; btn.classList.remove("ok"); }, 1400);
    } catch { /* clipboard denied */ }
  }));
  host.querySelectorAll(".ad-retry").forEach((btn) => btn.addEventListener("click", () => {
    const a = ME.adaptations.find((x) => x.id === btn.dataset.adid);
    if (!a) return;
    a.status = "queued";
    // `noteKind` goes with the note it classified — left behind, a re-queued
    // card that fails a second time on a different step would show the FIRST
    // run's chip wording.
    delete a.note; delete a.noteKind; delete a.attemptedAt;
    // `phase` and `phaseAt` belong to the run that FAILED. Left behind, the
    // re-queued card shows that run's progress — "finding the format", with a
    // clock counting from a timestamp minutes old — until the worker happens to
    // overwrite it, which reads as a script already well underway when nothing
    // has started. Clear them with the rest of the failed attempt's state.
    delete a.phase; delete a.phaseAt;
    save(); renderSide(); renderPane();
    say("Re-queued — it'll be picked up on the next pass.", "good");
  }));
  /* The .ad-again handler lived here — "run it again", a second model pass over
     the same video. Removed with its button: it spent a script from the
     allowance to produce a different-but-equivalent answer, and editing by hand
     covers the real need for nothing. Its `force: true` flag went with it — see
     queueAdaptation, which now enforces one script per video per brand with no
     way around it. */

  /* MANUAL EDITING — the creator's own words, not another model run. Open,
     close and save are all a re-render around the EDITING set; the textareas
     hold the working copy until Save, so Cancel needs no undo buffer and a
     reload cannot resurrect a half-finished edit. Nothing here calls the API,
     spends from the allowance, or can fail. */
  /* Every one of these re-renders the pane, which rebuilds the <details> from
     scratch and loses the open state — so the card you were editing snaps shut
     the moment you save, hiding the change you just made. Reopen it after each
     paint. In "by brand" mode the same script can appear in more than one
     place, so reopen ALL copies rather than an arbitrary first match. */
  const keepOpen = (adid) => {
    renderPane();
    document.querySelectorAll(`.bp-item[data-adid="${CSS.escape(adid)}"]`)
      .forEach((el) => {
        el.open = true;
        /* In the Library the script card is nested INSIDE its video entry, and
           reopening the script alone left it sitting inside a collapsed parent
           — so pressing edit looked like it closed the card, and you had to
           open the video again to reach the editor that was already there.
           On a brand page there is no parent and this is a no-op. */
        const entry = el.parentElement?.closest("details.lib-item");
        if (entry) entry.open = true;
      });
  };
  host.querySelectorAll(".ad-edit").forEach((btn) => btn.addEventListener("click", () => {
    EDITING.add(btn.dataset.adid);
    keepOpen(btn.dataset.adid);
  }));
  host.querySelectorAll(".ad-cancel").forEach((btn) => btn.addEventListener("click", () => {
    EDITING.delete(btn.dataset.adid);
    keepOpen(btn.dataset.adid);
  }));
  host.querySelectorAll(".ad-save").forEach((btn) => btn.addEventListener("click", () => {
    const a = ME.adaptations.find((x) => x.id === btn.dataset.adid);
    if (!a || !a.adaptation) return;
    stashEdits(host, a);
    /* A beat emptied to nothing is one the creator deleted by clearing it, so
       drop it rather than leave a blank row that renders as a gap. */
    a.adaptation.beats = (a.adaptation.beats || []).filter((b) =>
      (b.say || "").trim() || (b.do || "").trim() || (b.show || "").trim());
    a.editedAt = new Date().toISOString();
    EDITING.delete(a.id);
    save({ now: true });
    renderSide(); keepOpen(a.id);
    say("Saved your changes.", "good");
  }));
  host.querySelectorAll(".ed-add").forEach((btn) => btn.addEventListener("click", () => {
    const a = ME.adaptations.find((x) => x.id === btn.dataset.adid);
    if (!a || !a.adaptation) return;
    stashEdits(host, a);          // or adding a beat throws away the edit so far
    a.adaptation.beats = [...(a.adaptation.beats || []), { say: "", do: "", show: "" }];
    keepOpen(a.id);
  }));
  host.querySelectorAll(".ed-drop").forEach((btn) => btn.addEventListener("click", () => {
    const a = ME.adaptations.find((x) => x.id === btn.dataset.adid);
    if (!a || !a.adaptation) return;
    stashEdits(host, a);
    const i = Number(btn.dataset.beat);
    a.adaptation.beats = (a.adaptation.beats || []).filter((_, n) => n !== i);
    keepOpen(a.id);
  }));

  host.querySelectorAll(".ad-del").forEach((btn) => armDelete(btn, "Delete script", () => {
    trashAdaptations((x) => x.id === btn.dataset.adid);
    save(); renderSide(); renderPane();   // the video stays in the Library
  }));

  /* Turn an original script into a brand script. The video is already in the
     library, so this is the same "also write this for" move the finished cards
     offer — the only difference is that a creator who got here may have no
     brand yet, which is the moment asking for one is a favour rather than a
     toll gate.

     It re-runs the pipeline rather than reusing the source already stored on
     the entry. Reuse would be cheaper (~$0.05 against ~$0.13) and quicker, and
     is worth doing — but it means restructuring the paid worker, which is not
     something to ship untested. Filed in the handoff. */
  host.querySelectorAll(".ad-brandify").forEach((btn) => btn.addEventListener("click", () => {
    const a = ME.adaptations.find((x) => x.id === btn.dataset.adid);
    if (!a) return;
    const item = ME.library.find((l) => l.id === a.libraryId)
      || (a.sourceUrl ? ME.library.find((l) => l.canon === canonUrl(a.sourceUrl)) : null);
    if (!item) { say("That video isn't in your library any more.", "bad"); return; }

    const named = namedBrands();
    if (!named.length) {
      // No brand to write for yet — send them to make one. addBrand() lands on
      // the new brand with the website lookup open, and the video is still in
      // the Library waiting when they come back.
      say("Add a brand first — then write this for them.", "good");
      addBrand();
      return;
    }
    const spare = brandsWithout(item);
    if (!spare.length) {
      say("Every brand already has a script from this video.", "bad");
      return;
    }
    // One brand: no picker needed. Several: the Library row already lists them
    // as chips, so send them there rather than inventing a second picker.
    if (spare.length === 1) alsoWriteFor(item, [spare[0].id]);
    else { go({ kind: "library" }); say("Pick which brand to write it for.", "good"); }
  }));
}

// ---------- boot ----------
function renderAll() {
  // Land on New script. It is where the work happens — a brand page is a shelf
  // you visit to read what came back, not the thing you open the app to do.
  renderSide();
  renderPane();
  renderSyncBadge();
}

let unlocked = false;
function unlock() {
  if (unlocked) return;
  unlocked = true;
  document.getElementById("err").textContent = "";
  document.getElementById("gate").style.display = "none";
  document.getElementById("app").style.display = "block";
  renderAll();
  startLiveSync();
  // AFTER SIGN-IN. renderAll() has already painted the rail from the local
  // count; this repaints it with the server's the moment it answers. Not
  // awaited — a slow or missing RPC must not hold up the app opening.
  refreshAllowance();
}

/** Scripts are written off-page, so poll while the tab is visible and repaint
    only when something actually changed — and never mid-keystroke.

    The interval is adaptive: while this creator has something in the worker's
    queue, checking is cheap and the payoff (surfacing a finished script) is
    high, so poll every ~5s. Once the queue drains, back off to 60s — nothing
    is waiting to be noticed. A successful send kicks the loop immediately
    (each send site calls kickLiveSync() once its save() lands) rather than
    leaving it on whatever cadence it was idling at, which is what used to
    hand back 60–120s on the very send this exists to catch. The kick fires
    only after save() resolves, not from queueAdaptation itself — pull()
    replaces ME wholesale, and firing it while the new item is still
    unsaved would race the save and drop the item from local state. */
/* WHAT A REPAINT COULD ACTUALLY SHOW.
   While a script is in flight the worker re-stamps `claimedAt` every 45 seconds
   (the claim heartbeat), writes `phase`/`phaseAt` four times, and sets
   `attemptedAt`/`claimedBy` the moment it claims. Not one of those is read by
   any render path — `phase` reaches the screen only through etaFor(), which
   paintEta() re-runs in place — so comparing the raw JSON reported "something
   changed" and tore the pane down for a field nobody can see.

   A DENY list, not an allow list, on purpose: a field the worker starts writing
   tomorrow defaults to triggering a repaint, which is the safe direction to be
   wrong in. Adding a field here is a claim that no render reads it — check
   before you do.

   `status` is normalised because every render collapses queued and running
   through isWriting(): the claim changes the status string and changes nothing
   on screen. */
const SIG_BLIND = new Set(["phase", "phaseAt", "claimedAt", "claimedBy", "attemptedAt"]);
function paneSig() {
  return JSON.stringify({
    a: (ME.adaptations || []).map((a) => ({ ...a, status: isWriting(a) ? "queued" : a.status })),
    /* WHICH VIDEOS EXIST — ids only. Added 2026-08-19 alongside the
       tagged-video counter. pull() replaces ME wholesale, so a library row
       added or removed on another device moves nothing in ME.adaptations when
       that video has no scripts of its own; the rail's count, the Library list
       and its "Not scripted yet" block all read off exactly those rows, and
       none of them would have repainted. Ids rather than whole rows on
       purpose: a caption hydrating on another device still must not tear this
       pane down, and a title is not part of any count. */
    lib: (ME.library || []).map((l) => l.id),
  }, (k, v) => (SIG_BLIND.has(k) ? undefined : v));
}

let LIVE_STARTED = false;
let liveTimer = null;
let PANE_STALE = false;   // something changed while the creator was typing; repaint when they stop
let kickLiveSync = null;   // set once started; each successful send calls this after its save() lands
function startLiveSync() {
  if (LIVE_STARTED) return;
  LIVE_STARTED = true;
  const tick = async () => {
    clearTimeout(liveTimer);
    if (!SB_TOKEN || document.hidden) { schedule(); return; }
    if (SAVE_PENDING) { schedule(); return; }   // never pull over an unsaved edit
    const before = paneSig();
    try { await pull(); } catch { SYNC_OK = false; }
    renderSyncBadge();
    const editing = document.activeElement
      && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    /* THE RAIL REPAINTS EVEN MID-KEYSTROKE; THE PANE WAITS ITS TURN.
       `editing` is only ever true for an INPUT/TEXTAREA/SELECT, and every one
       of those lives in the pane or the sign-in gate — the rail is buttons and
       text — so renderSide() cannot take the caret, the selection or the focus
       ring away from anything. It used to sit inside the guard with
       renderPane(), and that STRANDED the counts: `before` is re-read from the
       already-changed state on the next tick, so a script that finished while
       someone was typing in the search box was never re-detected and the rail
       stayed wrong until some unrelated render happened to run.
       renderPane() genuinely cannot run while editing — it replaces
       #pane-body and would destroy the field being typed in — so it keeps the
       guard, but the fact that it OWES a repaint is now remembered rather than
       forgotten, and it lands on the first tick after the caret leaves. */
    if (paneSig() !== before) {
      PANE_STALE = true;
      renderSide();                                  // counts, editing or not
    }
    if (PANE_STALE && !editing) { PANE_STALE = false; renderPane(); }
    /* THE `else if` THAT USED TO LIVE HERE REBUILT THE WHOLE PANE EVERY 2.5s.
       Its job was real — the overdue warning is a function of elapsed time, not
       of ME.adaptations, so something has to re-evaluate it — but renderPane()
       replaces #pane-body's innerHTML, which destroys every <details> in it.
       That was the blink, and it is why an expanded script collapsed on its
       own. paintEta() does the same job on the nodes already on screen without
       replacing one of them, and is cheap enough to run unconditionally.
       It touches only .bp-eta text and .eta-seg classes, never a form control,
       so it is safe while `editing`. */
    paintEta(document);
    renderSendOverlay();
    schedule();
  };
  const schedule = () => {
    clearTimeout(liveTimer);
    // 2500 while something is being written, so a finished script is visible
    // within half the old blind spot; the idle 60000 is untouched — this only
    // runs while a creator is actually watching a card write, not as a
    // standing cost.
    // PANE_STALE borrows the same 2500: a repaint that was held back because
    // the creator was typing has to land soon after they stop, and on the idle
    // clock alone it could sit there for a full minute. The fast cadence ends
    // the moment the repaint lands, so it costs nothing once nobody is typing.
    liveTimer = setTimeout(tick, (writingQueue().length || PANE_STALE) ? 2500 : 60000);
  };
  /* AFTER EVERY SUCCESSFUL SEND. All four send sites call this once their
     save() has landed (2830, 2881, 2917, 3559), which is exactly the moment the
     allowance can have moved, so the refresh rides along here rather than being
     repeated four times and forgotten on the fifth. */
  kickLiveSync = () => { clearTimeout(liveTimer); refreshAllowance(); tick(); };
  schedule();
  // COMING BACK TO THE TAB. The row is re-pulled here already; the allowance
  // is the other half of the same "what changed while I was away".
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    refreshAllowance();
    tick();
  });
}

// The gate does double duty: sign in, or create an account. One form, one
// extra field, so the two paths can't drift apart.
/* Three modes, one form: sign in, create an account, and set a new password
   after a reset link. "reset" is the odd one — the person is already
   authenticated by the link they clicked, so it asks for no email and no old
   password, only the replacement. */
/* Which version of the privacy policy a new account agreed to. Bump it when the
   policy changes in a way that matters — the date in privacy/index.html is the
   human version of the same thing. Old rows keep the version they accepted.

   IT DOES NOT RE-PROMPT ANYONE. This constant is read in exactly one place —
   the signup handler, which stamps it onto a brand-new row — so bumping it
   records the new wording for everyone who signs up FROM NOW ON and changes
   nothing for an existing creator: no banner, no dialog, no second agreement.
   Do not treat a bump here as consent re-taken. The policy's own "changes to
   this policy" section promises an email for a material change, and that email
   is the mechanism; this is only the label on it. */
const PRIVACY_VERSION = "2026-08-18";

let GATE_MODE = "in";
function setGateMode(mode) {
  GATE_MODE = mode;
  const up = mode === "up";
  const reset = mode === "reset";
  const sent = mode === "sent";      // account made; waiting on the email link
  const pw = document.getElementById("pw");
  document.getElementById("gate-tagline").textContent =
    sent ? "check your email"
      : reset ? "choose a new password" : up ? "create your account" : "for creators";
  // The email is known from the link; asking for it again invites a typo that
  // would silently reset nothing.
  document.getElementById("email").hidden = reset;
  document.getElementById("pw2-wrap").hidden = !(up || reset);
  document.getElementById("pw2").value = "";
  // Agreement belongs to creating an account and nothing else. It is also
  // cleared on every mode change, so switching away and back cannot leave a
  // tick behind that the creator never made.
  document.getElementById("agree-wrap").hidden = !up;
  document.getElementById("agree").checked = false;
  document.getElementById("gate-go").textContent =
    reset ? "Save new password" : up ? "Create account" : "Enter";
  pw.setAttribute("autocomplete", up || reset ? "new-password" : "current-password");
  pw.placeholder = up || reset ? "Password — 8 characters or more" : "Password";
  /* "sent" is the state after a successful signup: the account exists and the
     only thing left is the link in their inbox. The whole form goes, because
     every field in it is refused until they confirm — offering a filled-in
     password box that cannot work is the app inviting a failure it already
     knows about. */
  document.getElementById("gate-form").hidden = sent;
  // Nothing to switch to mid-reset, and no point offering another reset mail.
  document.querySelector(".gate-switch").hidden = reset;
  document.getElementById("forgot-wrap").hidden = up || reset || sent;
  /* In "sent" this doubles as the safeguard the old wording carried in a
     sentence. sbSignUp cannot tell a NEW address from one that already has an
     account without leaking which is which, so both land here — and someone who
     re-used an existing address is waiting for a link that was never sent.
     "already have an account? sign in" is exactly what they need, and it says
     the same thing to everyone, so it leaks nothing. */
  document.getElementById("switch-lede").textContent =
    up || sent ? "Already have an account?" : "Don't have an account?";
  document.getElementById("switch-mode").textContent = up || sent ? "Sign in" : "Create one";
  document.getElementById("err").textContent = "";
  // The resend link belongs to a failed sign-in, not to the create form.
  document.getElementById("resend-wrap").hidden = true;
  // Both modes share one submit button, so a seat refusal that disabled it must
  // be lifted on the way back to sign-in or existing creators are locked out by
  // a rule that was never about them.
  document.getElementById("gate-go").disabled = false;
  if (up) { if (SEATS_OPEN === null) refreshSeats(); else applySeatState(); }
}

// The homepage CTA links to ?signup=1, so "Create your account" lands on the
// create form rather than the sign-in form the visitor has no credentials for.
if (/[?&]signup=1\b/.test(location.search)) setGateMode("up");

/* An invite link carries both halves — ?e=<address>&c=<code> — so the invited
   person types a password and nothing else. Filling these in is also the only
   way the address is guaranteed to match the invite: retyping it is where the
   typo lives, and a mismatched address reads as "you're not invited". */
if (INVITED_EMAIL) {
  document.getElementById("email").value = INVITED_EMAIL;
  setGateMode("up");
}
if (INVITE) {
  const f = document.getElementById("invite");
  if (f) f.value = INVITE;
}

/* Forgot password. Supabase answers /recover with 200 whether or not the
   address exists — deliberately, so the endpoint can't be used to find out who
   has an account — so the wording below must not claim a mail was sent. */
document.getElementById("gate-forgot").addEventListener("click", async () => {
  const err = document.getElementById("err");
  const btn = document.getElementById("gate-forgot");
  const email = (document.getElementById("email").value || "").trim();
  if (!email) {
    err.textContent = "Enter your email first, then tap Forgot your password.";
    document.getElementById("email").focus();
    return;
  }
  btn.disabled = true;
  err.textContent = "Sending…";
  try {
    // Same per-request redirect as signup: the link must come back to whichever
    // host served this page, not to the project's single Site URL.
    const back = encodeURIComponent(location.origin + CREATOR_PATH);
    const res = await fetch(`${SB_URL}/auth/v1/recover?redirect_to=${back}`, {
      method: "POST",
      headers: { apikey: SB_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error(String(res.status));
    err.textContent = "If that address has an account, a reset link is on its way. "
      + "Open it on this device and you can set a new password.";
  } catch (ex) {
    err.textContent = /429|rate/i.test(ex.message)
      ? "Too many attempts — wait a minute and try again."
      : "Couldn't send the reset link — check your connection and try again.";
  } finally { btn.disabled = false; }
});

/* Recovery for an address that never got its link, or whose link expired.
   Without this the only route is to sign up again — and Supabase answers a
   repeat signup for an existing address with a decoy that sends nothing, so
   the creator would be told to check an inbox nothing is coming to. With
   confirmation on and 50+ signups, some will land here; a dead end at the
   front door is the most expensive kind. */
let RESEND_FOR = "";

function showResend(email) {
  RESEND_FOR = email;
  document.getElementById("resend-wrap").hidden = false;
}

document.getElementById("gate-resend").addEventListener("click", async () => {
  const btn = document.getElementById("gate-resend");
  const err = document.getElementById("err");
  const email = RESEND_FOR || (document.getElementById("email").value || "").trim();
  if (!email) { err.textContent = "Enter your email first."; return; }
  btn.disabled = true;
  err.textContent = "Sending…";
  try {
    // Same per-request redirect as signup, so the link comes back to whichever
    // host served this page rather than the project's single Site URL.
    const back = encodeURIComponent(location.origin + CREATOR_PATH);
    const res = await fetch(`${SB_URL}/auth/v1/resend?redirect_to=${back}`, {
      method: "POST",
      headers: { apikey: SB_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "signup", email }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error_description || body.msg || body.message || "failed");
    err.textContent = "Sent — check your inbox, and your spam folder.";
    document.getElementById("resend-wrap").hidden = true;
  } catch (ex) {
    const m = String(ex.message || "");
    // Supabase answers /resend with 200 even for an address that is already
    // confirmed — the same refusal to confirm who has an account that signup
    // makes. So there is no "already confirmed" case to report here; only a
    // genuine transport or rate-limit failure reaches this branch.
    err.textContent = /rate|too many|429|for security purposes/i.test(m)
      ? "Too many emails just now — wait a minute and try again."
      : "Couldn't send it. Check the address and try again.";
  } finally { btn.disabled = false; }
});

document.getElementById("switch-mode").addEventListener("click", () => {
  setGateMode(GATE_MODE === "up" ? "in" : "up");
  document.getElementById(document.getElementById("email").value ? "pw" : "email").focus();
});

document.getElementById("gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  const btn = document.getElementById("gate-go");
  const email = (document.getElementById("email").value || "").trim();
  const pw = document.getElementById("pw");
  const pw2 = document.getElementById("pw2");

  /* Setting a new password after a reset link. Checked BEFORE the email test
     below, because this mode deliberately has no email field — the link
     already said who this is. */
  if (GATE_MODE === "reset") {
    if (pw.value.length < 8) { err.textContent = "Use at least 8 characters."; pw.select(); return; }
    if (pw.value !== pw2.value) { err.textContent = "Those two passwords don't match."; pw2.select(); return; }
    btn.disabled = true;
    err.textContent = "Saving…";
    try {
      // sbFetch carries the recovery session the link established, and refreshes
      // it if the person sat on this screen past the hour.
      await sbFetch("/auth/v1/user", { method: "PUT", body: JSON.stringify({ password: pw.value }) });
      pw.value = ""; pw2.value = "";
      await pull();
      unlock();
    } catch (ex) {
      err.textContent = /same.*password|different from the old/i.test(ex.message || "")
        ? "That's the password you already had — pick a different one."
        : "Couldn't save the new password. Ask for a fresh reset link and try again.";
      btn.disabled = false;
    }
    return;
  }

  if (!email || !pw.value) { err.textContent = "Enter your email and password."; return; }

  if (GATE_MODE === "up") {
    // Known-full: refuse here rather than sending a request that can only come
    // back as a 500. If the answer never arrived (SEATS_OPEN === null) the
    // signup goes ahead and the trigger decides — the check is a courtesy.
    if (SEATS_OPEN === false) { err.textContent = FULL_MSG; return; }
    if (pw.value.length < 8) { err.textContent = "Use at least 8 characters."; pw.select(); return; }
    if (pw.value !== pw2.value) { err.textContent = "Those two passwords don't match."; pw2.select(); return; }
    /* Checked here rather than with the `required` attribute: this form shares
       one submit handler with sign-in and password reset, where the box is
       hidden — and a hidden `required` control blocks submission with a browser
       bubble pointing at something nobody can see. */
    if (!document.getElementById("agree").checked) {
      err.textContent = "Please agree to the privacy policy to create an account.";
      return;
    }
    btn.disabled = true;
    err.textContent = "Creating your account…";
    try {
      const code = (document.getElementById("invite")?.value || INVITE).trim();
      const outcome = await sbSignUp(email, pw.value, code);
      pw.value = ""; pw2.value = "";
      if (outcome === "confirm") {
        /* "sent" hides the form outright. Nothing in it works until the link in
           their inbox is clicked, so leaving a password box on screen only
           invites an attempt that is refused. The "already have an account?
           sign in" line below the message covers the other case this branch
           lands on — a re-used address, where no email is sent — without
           naming which of the two happened, which sbSignUp deliberately will
           not reveal. */
        setGateMode("sent");
        err.textContent = "thanks — your account is created. "
          + "check your email for the link that signs you in.";
        return;
      }
      await pull();
      /* Record the agreement on the creator's own row, the same way the wait
         list records its consent tag: a version and a timestamp, so "what did
         this person actually agree to" stays answerable after the policy is
         reworded. Set before unlock() so the first save carries it. */
      ME.privacyAccepted = { version: PRIVACY_VERSION, at: new Date().toISOString() };
      save();
      unlock();
    } catch (ex) {
      err.textContent = signupError(ex.message);
    } finally { btn.disabled = false; }
    return;
  }

  btn.disabled = true;
  /* The mark, working — the same signal the brand lookup and the script write
     use. Every failure line below stays on textContent: those render messages
     derived from server responses, and innerHTML would make that an injection. */
  gateBusy(err, "Signing in…");
  let signedIn = false;
  try {
    await sbSignIn(email, pw.value);
    signedIn = true;
    pw.value = "";
    gateBusy(err, "Loading your account…");
    await pull();
    unlock();
  } catch (ex) {
    const m = ex.message || "";
    // Once sign-in succeeded the password was fine, so never blame it for what
    // is really a failure to load the account.
    if (/Email not confirmed/i.test(m)) showResend(email);
    err.textContent = signedIn ? accountLoadError(m)
      : /Email not confirmed/i.test(m)
      ? "Confirm your email first — check your inbox for the link."
      : /Invalid login|invalid_grant|Sign-in failed/i.test(m)
      ? "Wrong email or password."
      : "Could not sign in — check your connection.";
    pw.select();
  } finally { btn.disabled = false; }
});

/** Signed in, but the account wouldn't load. The commonest cause by a mile is
    that supabase/schema.sql has never been run, so lynxr_creators does not
    exist and PostgREST answers PGRST205. Reporting that as "check your
    connection" is how you end up retyping a correct password and then trying
    to create an account you already have. */
function accountLoadError(m) {
  if (/PGRST205|PGRST106|lynxr_creators|schema cache/i.test(m)) {
    return "Signed in — but the creator tables don't exist yet. Run supabase/schema.sql in the Supabase SQL editor.";
  }
  return "Signed in, but couldn't load your account — reload to retry.";
}

document.getElementById("toggle-pw").addEventListener("click", () => {
  const pw = document.getElementById("pw");
  const showing = pw.type === "text";
  pw.type = showing ? "password" : "text";
  const label = showing ? "Show password" : "Hide password";
  const b = document.getElementById("toggle-pw");
  b.setAttribute("aria-pressed", String(!showing));
  b.setAttribute("aria-label", label);
  b.setAttribute("title", label);
  pw.focus();
});

document.getElementById("side-new").addEventListener("click", addBrand);

// Always a FRESH composer, exactly like pressing new-chat: re-rendering the
// view is what clears the field and resets the company picker.
document.getElementById("nav-new").addEventListener("click", () => go({ kind: "new" }));

// Tapping the dimmed page closes the drawer. The scrim is a ::after
// pseudo-element on <body> so it can't carry its own handler — clicks on it
// land on <body>. Rail items already close it via go(); this covers the far
// more common "open it, change my mind, tap the page" gesture, which
// previously left the menu stuck open.
document.addEventListener("click", (e) => {
  if (!document.body.classList.contains("side-open")) return;
  if (e.target.closest("#side") || e.target.closest("#side-open")) return;
  document.body.classList.remove("side-open");
});

document.getElementById("nav-library").addEventListener("click", () => go({ kind: "library" }));
document.getElementById("nav-you").addEventListener("click", () => go({ kind: "you" }));
document.getElementById("nav-feedback").addEventListener("click", () => go({ kind: "feedback" }));
// The footer's Feedback link is a view, not a URL, exactly like nav-feedback
// above — it stays inside the app instead of navigating anywhere.
document.getElementById("foot-feedback")?.addEventListener("click", () => go({ kind: "feedback" }));

// The send overlay's only three exits — the X, Escape, and "Read it" (wired
// inside renderSendOverlay() itself, since that node is rebuilt on every
// repaint). No backdrop handler: it does not close on a click outside it.
document.getElementById("send-close")?.addEventListener("click", closeSendOverlay);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("send-modal")?.hidden) closeSendOverlay();
});

/** A confirmation (or recovery) link comes back here with the session in the
    URL fragment. Take it, strip it out of the address bar so the tokens never
    sit in history or get pasted into a chat, and go straight in — otherwise a
    creator clicks "confirm", lands on the login form, and has to type the
    password they set thirty seconds ago.

    Fragments never reach a server, so this is the only place that can read it;
    GitHub Pages sees nothing. */
async function sessionFromLink() {
  const hash = location.hash || "";
  if (!hash.includes("access_token") && !hash.includes("error")) return false;
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  history.replaceState(null, "", location.pathname + location.search);

  const err = p.get("error_description") || p.get("error");
  if (err) {
    document.getElementById("err").textContent = /expired|invalid/i.test(err)
      ? "That confirmation link has expired — sign up again to get a new one."
      : decodeURIComponent(err).replace(/\+/g, " ");
    return false;
  }
  const access_token = p.get("access_token"), refresh_token = p.get("refresh_token");
  if (!access_token || !refresh_token) return false;
  try {
    // The fragment carries no user object, and we need the id to read the row.
    const res = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${access_token}` } });
    if (!res.ok) return false;
    adoptSession({ access_token, refresh_token, user: await res.json() });
    // A recovery link authenticates but does NOT change the password. Dropping
    // straight into the app would look like success while leaving the old
    // password in place — so the next sign-in fails exactly as before and the
    // reset appears not to have worked. Say so by asking for the new one.
    return p.get("type") === "recovery" ? "recovery" : true;
  } catch { return false; }
}

// Arriving from a confirmation link, or a session already stored here.
(async function resume() {
  const link = await sessionFromLink();
  if (link === "recovery") {
    setGateMode("reset");
    document.getElementById("pw").focus();
    document.getElementById("err").textContent = "Set a new password to finish.";
    return;
  }
  if (link) {
    const had = restoreLocalMe();   // same reason as the session path below
    try { await pull(); } catch (ex) {
      if (!had) { document.getElementById("err").textContent = accountLoadError(ex.message || ""); return; }
      SYNC_OK = false;
      if (DIRTY) scheduleRetry();
    }
    unlock();
    return;
  }
  const sess = loadSession();
  if (!sess?.refresh_token) return;
  try { await sbRefresh(sess.refresh_token); }
  catch { clearSession(); return; }
  /* THE DEVICE MIRROR GOES IN FIRST, BEFORE THE NETWORK IS ASKED ANYTHING.
     Two things fall out of the order. A send that never reached Supabase is
     back in ME by the time pull() runs, so the merge carries it up instead of
     the server's copy erasing it — which is what made a dropped write
     permanent. And if pull() fails outright, there is still a row to open the
     app with: a creator on a dead connection sees their library and their
     waiting card rather than a sign-in error, and the outbox pushes whatever
     is pending the moment the connection returns. */
  const mirrored = restoreLocalMe();
  try {
    await pull();
  } catch (ex) {
    if (!mirrored) {
      document.getElementById("err").textContent = accountLoadError(ex.message || "");
      return;
    }
    SYNC_OK = false;
    if (DIRTY) scheduleRetry();
  }
  unlock();
})();

