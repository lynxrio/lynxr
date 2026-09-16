/* /creatorsonly/ IS RETIRED (owner, 2026-09-15: "you can delete the creators
   only, the creators either have an account or make an account on lynxr.io main
   page"). The creator app lives on the home page. This forwards every visit
   there WITH the query string and the fragment, because links already out in
   the world depend on them:
   - invites:          /creatorsonly/?signup=1&e=<email>&c=<code>
   - confirmations:    /creatorsonly/#access_token=…&refresh_token=…
   - password resets:  /creatorsonly/#access_token=…&type=recovery
   - expired links:    /creatorsonly/#error=…&error_description=…
   creator.js on the home page reads all four and opens the sign-in card.
   replace(), so Back does not return to this stub. An external file because
   the CSP blocks inline scripts; the meta refresh in index.html is the no-JS
   fallback and cannot carry the fragment. */
location.replace("/" + location.search + location.hash);
