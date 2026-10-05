// Checks the paste box's link rules (creator.js linkShape / linkProblem) against
// the SAME fixture the worker's Python rules are tested with.
//
//   node tools/test_link_shape.mjs
//
// pipeline/link_shapes.json is the shared truth: pipeline/test_link_checks.py
// runs it through link_shape() in process_adaptations.py, this runs it through
// the browser's linkShape(). If the two ever disagree, a link would pass the
// paste box and be refused at claim time (or the reverse) — the exact mismatch
// this file exists to catch.
//
// creator.js is a 12,000-line browser file with top-level DOM work, so it cannot
// be imported. The pure, URL-only functions sit between two marker comments;
// this slices that text out and evaluates it on its own, with nothing but URL.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "creator.js"), "utf8");
const BEGIN = "/* LINK-SHAPE:BEGIN";
const END = "/* LINK-SHAPE:END */";
const a = src.indexOf(BEGIN);
const b = src.indexOf(END);
if (a < 0 || b < 0 || b < a) {
  console.error("FAIL  could not find the LINK-SHAPE markers in creator.js");
  process.exit(1);
}
const slice = src.slice(a, b + END.length);
const { linkShape, linkProblem, platformOf, videoLikePath } = vm.runInNewContext(
  slice + "\n;({ linkShape, linkProblem, platformOf, videoLikePath })",
  { URL },
);

const fixture = JSON.parse(fs.readFileSync(path.join(root, "pipeline", "link_shapes.json"), "utf8"));
let fails = 0;
function check(name, ok, detail) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

for (const c of fixture) {
  const { url, expect } = c;
  if (expect === "off_platform") {
    check(`off_platform: ${url}`, platformOf(url) === null, `platformOf = ${platformOf(url)}`);
    const p = linkProblem(url);
    check(`off_platform sentence: ${url}`, typeof p === "string" && p.startsWith("lynxr only reads"), p);
    continue;
  }
  const shape = linkShape(url);
  check(`shape ${expect}: ${url}`, shape === expect, `got ${shape}`);
  const p = linkProblem(url);
  check(`problem is null exactly when ok: ${url}`, (p === null) === (expect === "ok"), p);
  check(`videoLikePath agrees: ${url}`, videoLikePath(url) === (expect === "ok"), String(videoLikePath(url)));
  if (expect === "cut_off") check(`cut-off sentence: ${url}`, typeof p === "string" && p.startsWith("That link looks cut off"), p);
  if (expect === "profile") check(`profile sentence: ${url}`, typeof p === "string" && p.startsWith("That's a profile"), p);
  if (expect === "photo") check(`photo sentence: ${url}`, typeof p === "string" && p.startsWith("That's a photo post"), p);
  if (expect === "page") check(`page sentence: ${url}`, typeof p === "string" && p.startsWith("That's a page, not a video"), p);
}

// Client-only cases: what a person actually types.
check("scheme-less valid tiktok link passes",
  linkProblem("tiktok.com/@leenabhushan/video/6748451240264420610") === null,
  linkProblem("tiktok.com/@leenabhushan/video/6748451240264420610"));
const cut = linkProblem("instagram.com/reels/OB5");
check("scheme-less cut-off instagram link gets the cut-off sentence",
  typeof cut === "string" && cut.startsWith("That link looks cut off"), cut);
check("empty box asks for a link",
  linkProblem("") === "Paste a TikTok or Instagram video link first.", linkProblem(""));

if (fails) {
  console.error(`\n${fails} FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
