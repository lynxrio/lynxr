"use strict";
const $ = (id) => document.getElementById(id);
const form = $("filters"),
  selected = new Map();
let page = 1,
  pages = 1,
  request = 0,
  overview;
const fmt = (v) =>
  v === null || v === undefined
    ? "Unknown"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(v);
const pct = (v) =>
  v === null || v === undefined ? "Unknown" : (v * 100).toFixed(2) + "%";
const day = (v) => (v ? v.slice(0, 10) : "Unknown");
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function query() {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData(form)) if (v) p.set(k, v);
  return p;
}
async function api(path) {
  const r = await fetch(path);
  if (!r.ok)
    throw Error(
      r.status === 400
        ? "Check the date range and filters, then try again."
        : "The local catalog could not be read. Check the server and retry.",
    );
  return r.json();
}
function error(message) {
  $("error").hidden = !message;
  $("error").textContent = message;
}
function tab(name) {
  document
    .querySelectorAll(".tab-section")
    .forEach((n) => (n.hidden = n.id !== name));
  document.querySelectorAll(".nav").forEach((n) => {
    n.classList.toggle("active", n.dataset.tab === name);
    n.setAttribute("aria-current", n.dataset.tab === name ? "page" : "false");
  });
}
document
  .querySelectorAll(".nav")
  .forEach((n) => n.addEventListener("click", () => tab(n.dataset.tab)));
$("evidence-link").addEventListener("click", () => tab("provenance"));
function selection() {
  $("compare-count").textContent = `${selected.size}/2`;
  $("compare").disabled = selected.size !== 2;
}
function original(record) {
  const a = el("a", "Open on Instagram ↗", "button primary detail-link");
  a.href = record.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
function dl(pairs) {
  const n = el("dl");
  pairs.forEach(([k, v]) => n.append(el("dt", k), el("dd", v)));
  return n;
}
function card(title, pairs) {
  const n = el("article", undefined, "comparison-card");
  n.append(el("h3", title), dl(pairs));
  return n;
}
function cohortTable(target, rows) {
  const wrap = el("div", undefined, "table-wrap"),
    table = el("table"),
    head = el("tr");
  [
    "COHORT",
    "RECORDS",
    "MEDIAN VIEWS",
    "MEDIAN INTERACTION RATIO",
    "RATIO KNOWN N",
  ].forEach((t) => head.append(el("th", t)));
  const thead = el("thead"),
    body = el("tbody");
  thead.append(head);
  rows.forEach((r) => {
    const tr = el("tr");
    [
      r.label,
      fmt(r.n),
      fmt(r.median_views),
      pct(r.median_engagement_per_view),
      fmt(r.engagement_measured_n),
    ].forEach((t) => tr.append(el("td", t)));
    body.append(tr);
  });
  table.append(thead, body);
  wrap.append(table);
  $(target).replaceChildren(wrap);
}
function cohorts(summary) {
  $("quartiles").replaceChildren(
    ...summary.observed_view_quartiles.map((r) =>
      card(r.label, [
        ["Records", fmt(r.n)],
        ["Median observed views", fmt(r.median_views)],
        ["Median duration", fmt(r.median_duration) + "s"],
        ["Median interaction ratio", pct(r.median_engagement_per_view)],
        ["Ratio known N", fmt(r.engagement_measured_n)],
        ["Relative performance", "Unavailable"],
      ]),
    ),
  );
  cohortTable("duration-cohorts", summary.duration_cohorts);
  cohortTable("cue-cohorts", summary.caption_cue_cohorts);
}
async function catalog() {
  const serial = ++request,
    p = query();
  p.set("page", page);
  try {
    const data = await api("/api/catalog?" + p);
    if (serial !== request) return;
    error("");
    pages = data.pages;
    cohorts(data.summary);
    $("views-heading").textContent =
      "VIEWS" +
      (p.get("sort") === "views"
        ? p.get("direction") === "asc"
          ? " ↑"
          : " ↓"
        : "");
    $("result-count").textContent = fmt(data.total);
    $("page-label").textContent = data.total
      ? `Page ${page} of ${pages} · ${fmt(data.total)} matching source records`
      : "No records match. Clear a filter and try again.";
    $("previous").disabled = page <= 1;
    $("next").disabled = page >= pages;
    $("export-json").href = "/api/export.json?" + query();
    $("export-csv").href = "/api/export.csv?" + query();
    const rows = data.items.map((r) => {
      const tr = el("tr"),
        check = el("input");
      check.type = "checkbox";
      check.checked = selected.has(r.id);
      check.setAttribute("aria-label", `Select ${r.creator} ${r.id}`);
      check.addEventListener("change", () => {
        if (check.checked && selected.size >= 2) {
          check.checked = false;
          error(
            "Two records are already selected. Deselect one to compare another.",
          );
          return;
        }
        if (check.checked) selected.set(r.id, r);
        else selected.delete(r.id);
        error("");
        selection();
      });
      const selectCell = el("td");
      selectCell.append(check);
      const creator = el("td"),
        title = el("button", "@" + r.creator, "row-title");
      title.addEventListener("click", () => detail(r.id));
      creator.append(
        title,
        el("span", `${r.id} · ${fmt(r.duration)}s`, "row-sub"),
      );
      const cue = el("td");
      cue.append(el("span", r.caption_cue, "cue"));
      const link = el("a", "↗", "original");
      link.href = r.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute(
        "aria-label",
        `Open original Reel ${r.id} on Instagram`,
      );
      const linkCell = el("td");
      linkCell.append(link);
      tr.append(
        selectCell,
        creator,
        el("td", day(r.published_at), "muted"),
        el("td", fmt(r.views), "metric"),
        el("td", fmt(r.video_play_count), "metric"),
        el("td", pct(r.engagement_per_view)),
        cue,
        linkCell,
      );
      return tr;
    });
    if (!rows.length) {
      const tr = el("tr"),
        td = el("td", "No matching real records. Try a broader query.");
      td.colSpan = 8;
      tr.append(td);
      rows.push(tr);
    }
    $("rows").replaceChildren(...rows);
  } catch (e) {
    if (serial === request) error(e.message);
  }
}
form.addEventListener("submit", (e) => {
  e.preventDefault();
  page = 1;
  catalog();
});
form.addEventListener("reset", () => {
  page = 1;
  selected.clear();
  selection();
  setTimeout(catalog, 0);
});
$("previous").addEventListener("click", () => {
  if (page > 1) {
    page--;
    catalog();
  }
});
$("next").addEventListener("click", () => {
  if (page < pages) {
    page++;
    catalog();
  }
});
function showDialog(nodes) {
  $("detail-content").replaceChildren(...nodes);
  $("detail").showModal();
}
$("close-dialog").addEventListener("click", () => $("detail").close());
async function detail(id) {
  try {
    const {
      record: r,
      creator_reference: b,
      source: s,
    } = await api("/api/record/" + encodeURIComponent(id));
    const n = el("div");
    n.append(
      el("span", "SOURCE RECORD · LIVE AVAILABILITY UNKNOWN", "eyebrow"),
      el("h2", "@" + r.creator),
      original(r),
    );
    n.append(
      card("Observed metadata", [
        ["Published · UTC", r.published_at || "Unknown"],
        ["Views / plays", `${fmt(r.views)} / ${fmt(r.video_play_count)}`],
        ["Likes / comments", `${fmt(r.likes)} / ${fmt(r.num_comments)}`],
        ["Interaction ratio", pct(r.engagement_per_view)],
        ["Duration / source type", `${fmt(r.duration)}s / ${r.product_type}`],
        ["Caption cue · inferred", r.caption_cue],
      ]),
    );
    n.append(
      card("Creator reference — baseline unavailable", [
        ["Sampled Reels", fmt(b.sample_posts)],
        ["Selected-sample median views", fmt(b.sample_median_views)],
        ["Historical baseline", "Unavailable"],
        ["Normalized outcome", "Unavailable"],
        ["Required other posts", fmt(b.required_other_posts)],
        ["Reason", b.reason],
      ]),
    );
    n.append(el("p", b.interpretation, "detail-caption"));
    n.append(
      card("When and how was this measured?", [
        ["Original metric observation", "Not supplied"],
        ["Original metric collection", "Not supplied"],
        ["Dataset Git publication", s.repository_published_at],
        ["Local download", s.downloaded_at],
        ["Native post ID", r.post_id],
        ["CSV logical row", r.source_rows.join(", ")],
        [
          "Source data quality",
          Object.keys(r.quality).length
            ? JSON.stringify(r.quality)
            : "No counter sentinel flags",
        ],
        ["Media access", "Not loaded · rights unverified"],
      ]),
    );
    n.append(
      el("h3", "Caption excerpt · source text"),
      el(
        "p",
        r.caption.slice(0, 280) || "No caption supplied",
        "detail-caption",
      ),
    );
    showDialog([n]);
  } catch (e) {
    error(e.message);
  }
}
$("compare").addEventListener("click", () => {
  const grid = el("div", undefined, "comparison-grid");
  selected.forEach((r) => {
    const n = card("@" + r.creator, [
      ["Posted", day(r.published_at)],
      ["Observed views", fmt(r.views)],
      ["Observed plays", fmt(r.video_play_count)],
      ["Interaction ratio", pct(r.engagement_per_view)],
      ["Duration", fmt(r.duration) + "s"],
      ["Caption cue · inferred", r.caption_cue],
      ["Relative performance", "Unavailable: no comparable-age baseline"],
      ["Metric observed at", "Unknown"],
    ]);
    n.append(original(r));
    grid.append(n);
  });
  showDialog([
    el("span", "SIDE-BY-SIDE · DESCRIPTIVE ONLY", "eyebrow"),
    el("h2", "Compare the observations."),
    el(
      "p",
      "Higher absolute counts do not imply outperformance relative to a creator’s usual results.",
      "detail-caption",
    ),
    grid,
  ]);
});
function provenance(s, all) {
  const root = $("provenance-content");
  const a = card("Four clocks. Different meanings.", [
    ["Video publication", "Supplied per record"],
    [
      "Original metric observation",
      "Not supplied · 0 qualified historical observations",
    ],
    ["Original metric collection", "Not supplied"],
    ["Dataset Git publication", s.repository_published_at],
    ["Local download", s.downloaded_at],
    ["Local ingestion", s.ingested_at],
  ]);
  a.className = "provenance-card";
  a.append(
    el(
      "p",
      "The Git timestamp is an availability bound for the dataset, not the date its counters were measured. Downloading in 2026 does not refresh Instagram.",
    ),
  );
  const b = card("Source inventory", [
    ["Raw CSV records", fmt(s.audit.raw_rows)],
    [
      "Reels / other source types",
      `${fmt(overview.reels.n)} / ${fmt(all.n - overview.reels.n)}`,
    ],
    ["Quarantined rows", fmt(s.audit.quarantined_rows)],
    ["Unknown/negative likes", fmt(all.unknown_likes)],
    ["Missing plays", fmt(all.unknown_plays)],
    ["Live/deleted status", `${fmt(all.n)} unknown; not checked`],
    ["Source commit", s.commit],
    ["CSV SHA-256", s.sha256],
  ]);
  b.className = "provenance-card";
  b.append(
    el(
      "p",
      "The README advertises 6,850 records; the pinned CSV contains 1,000. The selected sample has no documented listing frame, inclusion probabilities or deletion ledger. Missing failures cannot be reconstructed.",
    ),
  );
  const c = el("article", undefined, "provenance-card");
  c.append(
    el("h3", "Rights & interpretation"),
    el(
      "p",
      "Local sample evaluation only, based on the provider’s stated testing and proof-of-concept uses. The repository has no open-data license. No dataset redistribution, video downloads, thumbnail requests or embedded players. Caption cues do not establish real video structure.",
    ),
  );
  [
    ["Source repository", s.repository],
    ["Sample-use policy", s.rights.policy_url],
    ["Provider terms", s.rights.terms_url],
  ].forEach(([text, url]) => {
    const a = el("a", text);
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    c.append(a, el("br"));
  });
  root.replaceChildren(a, b, c);
}
async function start() {
  try {
    overview = await api("/api/overview");
    const { source: s, reels: r, all_records: all } = overview;
    $("stat-reels").textContent = fmt(r.n);
    $("stat-source").textContent =
      `${fmt(all.n)} source records · ${fmt(all.n - r.n)} other types retained`;
    $("stat-median").textContent = fmt(r.median_views);
    $("stat-creators").textContent = fmt(r.creators);
    $("source-summary").textContent =
      `Pinned CSV · downloaded ${day(s.downloaded_at)}`;
    const max = Math.max(1, ...r.histogram.map((b) => b.n));
    $("histogram").replaceChildren(
      ...r.histogram.map((b) => {
        const n = el("div", undefined, "hist-col"),
          bar = el("i");
        bar.style.height = (b.n / max) * 46 + "px";
        n.append(el("b", fmt(b.n)), bar, el("small", b.label));
        return n;
      }),
    );
    provenance(s, all);
    await catalog();
  } catch (e) {
    error(e.message);
  }
}
start();
