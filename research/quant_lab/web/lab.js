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
const multiple = (v) => v === null || v === undefined ? "Unavailable" : new Intl.NumberFormat("en-US", {minimumFractionDigits:2, maximumFractionDigits:3}).format(v) + "×";
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
  const a = el("a", "Open original on Instagram", "button primary detail-link");
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
form.elements.source.addEventListener("change", () => {
  selected.clear(); selection();
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
        ["Published", r.published_at || "Unknown"],
        ["Publication precision", r.publication_precision === "calendar_day_timezone_unspecified" ? "Calendar day · time and timezone not supplied" : "Timestamp · UTC"],
        ["Source", s.name],
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
    if (r.annotations) {
      const ref = b.age_band_reference;
      n.append(card("Same-account age-band reference · descriptive", [
        ["Calendar age / band", fmt(r.age_calendar_days) + " days / " + ref.age_band],
        ["OTHER sampled posts", fmt(ref.other_posts)],
        ["Other-post median views", fmt(ref.other_median_views)],
        ["Observed views / reference median", ref.descriptive_ratio === null ? "Unavailable · sparse group" : multiple(ref.descriptive_ratio)],
        ["Limitation", ref.limitation],
      ]));
      n.append(card("Published human structure annotations", annotationPairs(r)));
      n.append(el("p", "Single coder, not fully blinded. Lynxr has not downloaded or independently reannotated this video. Attention-retention potential is a judgment, not audience retention.", "detail-caption"));
      n.append(el("p", s.attribution, "detail-caption"));
      const raw = el("details");
      raw.append(el("summary", "Inspect all original workbook cell values"), el("pre", JSON.stringify(r.source_cells, null, 2)));
      n.append(raw);
    }
    n.append(
      card("When and how was this measured?", [
        ["Original metric observation", r.metric_observed_date ? r.metric_observed_date + " · calendar date; timezone/time unknown" : "Not supplied"],
        ["Original metric collection", "Not supplied"],
        ["Dataset Git publication", s.repository_published_at],
        ["Local download", s.downloaded_at],
        ["Native numeric post ID", r.post_id || "Not supplied · shortcode identifies linked post"],
        ["Source row identity", r.source_study_id ? "Study Video ID " + r.source_study_id : "CSV row " + r.source_rows.join(", ")],
        ["Source sheet / row", (r.source_id === "educational-reels" ? "Analysis / " : "CSV / ") + r.source_rows.join(", ")],
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
      ["Observed views", fmt(r.views) + (r.counter_text ? " · source " + r.counter_text.views : "")],
      ["Observed plays", fmt(r.video_play_count)],
      ["Interaction ratio", pct(r.engagement_per_view)],
      ["Duration", fmt(r.duration) + "s"],
      ["Caption cue · inferred", r.caption_cue],
      ["Relative performance", "Unavailable: no comparable-age baseline"],
      ["Metric observation", r.metric_observed_date || "Unknown"],
      ["Source", r.source_id || "Bright Data"],
    ]);
    n.append(original(r));
    if (r.annotations) n.append(dl(annotationPairs(r)));
    grid.append(n);
  });
  if (new Set([...selected.values()].map((r) => r.source_id)).size > 1) {
    showDialog([el("h2", "Choose two records from one source"), el("p", "Counter definitions and sampling methods differ. Cross-source counts are not a valid pooled comparison.")]);
    return;
  }
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
    el("h3", "Bright Data rights & interpretation"),
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
  const annotated = overview.sources.find((source) => source.source_id === "educational-reels");
  if (annotated) {
    const d = card("Licensed annotated source", [
      ["Source", annotated.name], ["License", annotated.rights.license],
      ["Dataset publication date", annotated.repository_published_at],
      ["Coding-date range", annotated.coding_date_range.join(" to ") + " · date precision only"],
      ["Local download receipt", annotated.downloaded_at || "Unavailable"],
      ["Workbook SHA-256", annotated.sha256], ["Sampling", annotated.listing_frame],
      ["Media processing rights", "Not established · no media fetched"],
    ]);
    d.className = "provenance-card";
    d.append(el("p", annotated.attribution), el("p", annotated.limitations.join(". ")));
    root.append(d);
  }
}
function annotationPairs(r) {
  const a = r.annotations;
  return [["Hook type · human", a.hook_type || "Missing"],
    ["Hook duration · human", fmt(a.hook_duration_seconds) + "s"],
    ["Pacing / delivery", (a.editing_pace || "Missing") + " / " + (a.delivery_style || "Missing")],
    ["Introduction / clear ending", (a.introduction || "Missing") + " / " + (a.clear_ending || "Missing")],
    ["CTA · human", a.cta || "Missing"],
    ["Subtitles / overlays", (a.subtitles || "Missing") + " / " + (a.text_overlays || "Missing")],
    ["Reveal / product-entry timing", "Not supplied"]];
}
function researchTable(headers, rows) {
  const wrap = el("div", undefined, "table-wrap"), table = el("table"), head = el("tr"), body = el("tbody"), thead = el("thead");
  headers.forEach((h) => head.append(el("th", h)));
  thead.append(head);
  rows.forEach((values) => { const row = el("tr"); values.forEach((v) => {
    const cell = el("td"); if (v instanceof Node) cell.append(v); else cell.textContent = v; row.append(cell);
  }); body.append(row); });
  table.append(thead, body); wrap.append(table); return wrap;
}
function creatorButton(name) {
  const b = el("button", "@" + name, "row-title");
  b.addEventListener("click", () => {
    form.reset(); form.elements.source.value = "educational-reels"; form.elements.creator.value = name;
    page = 1; selected.clear(); selection(); catalog(); tab("catalog");
  }); return b;
}
function renderResearch(data) {
  $("research-summary").replaceChildren(
    el("p", `${fmt(data.real_reels_total)} genuine Reel records. ${fmt(data.annotated_reels)} have published human annotations across ${fmt(data.annotated_creators)} accounts. ${fmt(data.descriptive_reference_n)} support a coarse age-band reference; 0 qualify for historical prediction.`),
    el("p", "Grigorii Tvorogov (2026), Educational Instagram Reels, v1.0, CC BY 4.0. Changes: catalog projection and descriptive analysis. No endorsement. One snapshot per video; exact observation times unknown. No video media copied."));
  const sourceLink = el("a", "Dataset, codebook and methods report");
  sourceLink.href = "https://doi.org/10.5281/zenodo.23301344"; sourceLink.target = "_blank"; sourceLink.rel = "noopener noreferrer";
  $("research-summary").append(sourceLink);
  const pairs = data.example_pairs.map((pair) => {
    const root = el("article", undefined, "research-pair");
    root.append(el("h3", "@" + pair.creator + " · " + pair.age_band + " · " + pair.comparable_sample_n + " sampled posts"));
    const grid = el("div", undefined, "comparison-grid");
    for (const [label, item] of [["Lower observed views", pair.lower], ["Higher observed views", pair.higher]]) {
      const r = item.record, ref = item.reference;
      const n = card(label, [["Source views", fmt(r.views) + " (" + r.counter_text.views + ")"],
        ["Comments", fmt(r.num_comments)], ["Published / coded", day(r.published_at) + " / " + r.metric_observed_date],
        ["Calendar age / duration", r.age_calendar_days + " days / " + fmt(r.duration) + "s"],
        ["Other-post reference median", fmt(ref.other_median_views) + " · n=" + ref.other_posts],
        ["Views / descriptive reference", ref.descriptive_ratio === null ? "Unavailable" : multiple(ref.descriptive_ratio)],
        ...annotationPairs(r)]);
      const inspect = el("button", "Inspect metadata and provenance"); inspect.addEventListener("click", () => detail(r.id));
      n.append(el("p", r.id, "detail-caption"), original(r), inspect); grid.append(n);
    }
    root.append(grid); return root;
  });
  $("research-examples").replaceChildren(...pairs);
  $("creator-comparisons").replaceChildren(researchTable(
    ["CREATOR", "POSTS", "MEDIAN VIEWS", "OBSERVED VIEW RANGE", "CALENDAR AGE RANGE", "REFERENCE AVAILABLE N"],
    data.creator_comparisons.map((r) => [creatorButton(r.creator), fmt(r.n), fmt(r.median_views), fmt(r.min_views) + " – " + fmt(r.max_views), r.age_days_min + " – " + r.age_days_max + " days", fmt(r.reference_available_n)])));
  $("structure-comparisons").replaceChildren(...data.structure_comparisons.map((group) => {
    const n = el("article", undefined, "structure-group");
    n.append(el("h4", group.field.replaceAll("_", " ") + " · varies within " + group.within_creator_variation_n + " / " + data.annotated_creators + " accounts"));
    n.append(researchTable(["HUMAN CATEGORY", "POSTS", "ACCOUNTS", "MEDIAN VIEWS", "MEDIAN REFERENCE RATIO", "REFERENCE N"], group.groups.map((r) => [r.label, fmt(r.n), fmt(r.creators), fmt(r.median_views), r.median_descriptive_ratio === null ? "Unavailable" : multiple(r.median_descriptive_ratio), fmt(r.reference_n)])));
    return n;
  }));
  $("structure-coverage").replaceChildren(dl(Object.entries(data.structure_coverage).map(([k, v]) => [k.replaceAll("_", " "), v])), el("p", "Missingness: " + data.missingness.annotated_zero_comments + " zero-comment posts retained; " + data.missingness.annotated_below_1000_observed_views + " posts below 1,000 observed views retained. Skipped/deleted counts are unavailable; no failure rate can be estimated."));
  $("prospective-route").replaceChildren(el("p", data.prospective_first_observation), el("p", "Lawful route for missing video structure: creator-owned footage with explicit local processing rights, or creator-supplied timestamped annotations. Do not infer reveal/product integration from captions."));
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
      `${fmt(r.n)} provider Reels · licensed annotated source ${overview.sources.some((source) => source.source_id === "educational-reels") ? "loaded separately" : "not yet imported"}`;
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
    const research = await api("/api/research");
    renderResearch(research);
    await catalog();
  } catch (e) {
    error(e.message);
  }
}
start();
