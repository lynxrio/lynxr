/* /join/?c=CODE is the share link (owner, 2026-11-21): its own Open Graph tags give the Messages bubble an invite
   preview; this forwards to the landing, which shows the friend's banner. A bad or missing code goes to / plain. */
(function () {
  var q = new URLSearchParams(location.search);
  var c = (q.get("c") || "").trim().toUpperCase();
  q.delete("c");
  if (/^[A-HJ-NP-Z2-9]{8}$/.test(c)) q.set("join", c);
  var s = q.toString();
  location.replace("/" + (s ? "?" + s : "") + location.hash);
})();
