/* /refunds/ IS RETIRED (owner, 2026-10-08): the refund policy is now the
   "refunds" section of the terms of service. Old links, Stripe receipts and
   the Stripe dashboard's refund-policy URL may still point here, so this
   forwards every visit to /terms/#refunds. replace(), so Back does not
   return to this stub. An external file because the CSP blocks inline
   scripts (same pattern as /creatorsonly/forward.js); the meta refresh in
   index.html is the no-JS fallback. */
location.replace("/terms/#refunds");
