"use strict";
const get = id => document.getElementById(id);
const node = (tag, text) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
let context;
async function read(path) { const r = await fetch(path); if (!r.ok) throw Error("The offline research response could not be read."); return r.json(); }
function table(rows) {
  const t = node("table"), head = node("thead"), tr = node("tr"), body = node("tbody");
  ["Human hook label", "Posts", "Creators", "Reference N", "Median reference ratio", "Exploratory stability range", "Review priority"].forEach(x => tr.append(node("th",x)));
  head.append(tr);
  rows.forEach(r => { const row = node("tr"); [r.human_hook_label,r.posts,r.sampled_creators,r.eligible_reference_posts,
    r.median_descriptive_ratio === null ? "Unavailable" : r.median_descriptive_ratio.toFixed(3)+"×",
    r.stability.interval ? r.stability.interval.map(v=>v.toFixed(3)).join("–")+"×" : "Insufficient clusters",
    r.review_priority].forEach(v=>row.append(node("td",String(v)))); body.append(row); });
  t.append(head,body); return t;
}
function choosePost() {
  const p = context.posts[Number(get("annotation-post").value)];
  get("original-source").href = p.url;
  get("format-json").value = JSON.stringify(context.template.format,null,2);
  get("draft-status").textContent = "No labels inferred or prefilled. Unknown values remain null.";
}
get("annotation-post").addEventListener("change",choosePost);
get("annotation-form").addEventListener("submit",event=> {
  event.preventDefault();
  try {
    const p = context.posts[Number(get("annotation-post").value)];
    const annotation = {...context.template, source_id:p.source_id, post_id:p.post_id, creator_id:p.creator_id,
      annotator:get("annotator").value.trim(), grant_id:get("grant-id").value.trim(), created_at:new Date().toISOString(),
      evidence_type:get("evidence-mode").value, evidence_reference:get("evidence-reference").value.trim(),
      duration_s:p.duration_s, format:JSON.parse(get("format-json").value)};
    const url = URL.createObjectURL(new Blob([JSON.stringify(annotation,null,2)],{type:"application/json"}));
    const a = node("a"); a.href=url; a.download="lynxr-annotation-draft.json"; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    get("draft-status").textContent="Draft downloaded. It has not been admitted. Run the documented annotate command with current permission evidence; validation may reject unsupported visual claims.";
  } catch { get("draft-status").textContent="Check that format annotation is valid JSON. No annotation saved."; }
});
async function start() {
  try {
    const [report, data] = await Promise.all([read("/api/intelligence"),read("/api/annotation-context")]);
    context=data;
    get("signal-summary").textContent=`${report.catalog.real_posts} genuine licensed posts. Exact observation clocks and early velocity unavailable. No predictive alpha evaluated.`;
    get("signal-table").replaceChildren(table(report.catalog.review_ranking));
    get("scope").textContent=report.catalog.limitations.join(" ")+" Bootstrap ranges describe selected-sample stability, not causal effects. Publication-week counts in the export are descriptive cohorts, not observed adoption changes.";
    const authorized=report.authorized_exports;
    get("authorized-state").textContent=authorized.status ? `${authorized.status}: ${authorized.reason}` : `${authorized.observations} timestamp-qualified observations across ${authorized.post_count} posts. ${authorized.pending_unknown_clock_rows} rows await source clocks. Historical recommendation evaluation: ${authorized.recommendation_baseline_evaluation.status}.`;
    if (report.manual_annotations) get("authorized-state").append(node("p", `${report.manual_annotations.length} currently permitted annotation artifacts. Annotation reviews are not creator analytics outcomes.`));
    context.posts.forEach((p,i)=>{ const option=node("option",`${p.creator_id} · ${p.post_id} · ${p.source_id}`); option.value=String(i); get("annotation-post").append(option); });
    get("taxonomy").textContent=JSON.stringify(context.taxonomy,null,2);
    if (context.posts.length) choosePost();
    else { get("draft-status").textContent="No licensed annotation records loaded. Use the expanded catalog; no synthetic substitute is supplied."; get("annotation-form").querySelector("button[type=submit]").disabled=true; }
  } catch(e) { get("error").hidden=false; get("error").textContent=e.message; }
}
start();
