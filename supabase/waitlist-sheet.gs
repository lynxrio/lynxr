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
 */

var SHEET_ID = '1ypPfMkF6jpyQJ-9WCNoyjcjTenXrePhMz2uv96LjScY';
var HEADERS = ['when', 'email', 'source'];

function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];

    // Write the header row once, so a fresh sheet is readable immediately.
    if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);

    sheet.appendRow([
      d.created_at || new Date().toISOString(),
      d.email || '',
      d.source || 'landing'
    ]);
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
