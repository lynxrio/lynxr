/**
 * lynxr — mirror creator feedback into a Google Sheet.
 *
 * Sheet: https://docs.google.com/spreadsheets/d/1wCd0fQ84F0I39qyHEwZmKcagSnGpwHUuXEqwsPLOmhE/
 *
 * SETUP (about two minutes, and it has to be you — it runs as your account):
 *   1. Open that sheet -> Extensions -> Apps Script.
 *   2. Delete whatever is there, paste this whole file, Save.
 *   3. Deploy -> New deployment -> type "Web app".
 *        Execute as:        Me
 *        Who has access:    Anyone
 *   4. Copy the /exec URL it gives you.
 *   5. Put that URL in FEEDBACK_SHEET_URL at the top of creator.js.
 *
 * DONE 2026-08-11 — deployed and wired. Verified by POSTing a row from the
 * command line and getting back 'ok' from doPost. If you ever redeploy with
 * a NEW version, Apps Script issues a NEW /exec URL: update creator.js too,
 * or feedback keeps reaching Supabase while the sheet quietly stops filling.
 *
 * WHY "Anyone": the creator app is a static public site and cannot hold a
 * Google credential — anything it ships is readable by everyone. An open
 * endpoint that only ever APPENDS is the safe shape here. Treat the sheet as
 * append-only and spammable; Supabase's lynxr_feedback table is the record.
 */

var SHEET_ID = '1wCd0fQ84F0I39qyHEwZmKcagSnGpwHUuXEqwsPLOmhE';
var HEADERS = ['when', 'kind', 'message', 'email', 'name', 'creator_id', 'page'];

function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];

    // Write the header row once, so a fresh sheet is readable immediately.
    if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);

    sheet.appendRow([
      d.created_at || new Date().toISOString(),
      d.kind || '',
      d.message || '',
      d.email || '',
      d.name || '',
      d.creator_id || '',
      d.page || ''
    ]);
    return ContentService.createTextOutput('ok');
  } catch (err) {
    // Never throw: the browser cannot read the response anyway (no-cors), and
    // the feedback is already safe in Supabase.
    return ContentService.createTextOutput('error: ' + err);
  }
}

function doGet() {
  return ContentService.createTextOutput('lynxr feedback endpoint — POST only');
}
