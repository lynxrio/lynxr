# Rebrand and future public-release checklist

Public release and App Store submission are deferred. No enrollment, TestFlight,
app record, upload or review submission has been performed.

## Rebranding

- Choose display name and cleared trademark. Set `LYNXR_DISPLAY_NAME` through
  `app.config.js`; replace `src/branding.ts`, native Share Extension strings and
  screen copy. Search `mobile/` for remaining Lynxr labels. No server identity
  should depend on a display name.
- Provide the approved opaque 1024px icon and splash assets; configure them in
  `app.json` and regenerate native output. No production web branding is changed.
- Confirm organization bundle ID **before** distributing. App Group derives from
  it; changing it affects inbox and Keychain continuity. Use separate temporary
  development IDs for free personal signing. Keep display name changes separate
  from persistent bundle identity.
- Replace support/privacy links and approve the actual public privacy text.
  Re-capture screenshots from the branded native app, never fabricated mockups.
- Clean prebuild, rerun tests and verify both target names/versions/entitlements.

## Release gates and ownership

| Severity | Gate | Precise action |
|---|---|---|
| Critical | Real generation unverified | Approve a nonproduction project and limited provider budget; run a permitted source through the actual pipeline and inspect the result and allowance ledger. |
| High | Physical lifecycle/share behavior unverified | Founder signs a development build with a free Apple Account and connects an iPhone; execute the checklist in INTERNAL_TESTING.md. |
| High | Deletion/report handling operational | Assign an operator, completion notification, deletion deadline and content-report response; rehearse full synthetic-account deletion and billing handling in staging. A request alone is not completed deletion. |
| High | Public content/moderation policy | Review generated-content safeguards, reporting/blocking/contact processes and authorized source rights; no claim that a checkbox establishes copyright permission. |
| High | Public infrastructure approval | Review, approve and deploy the narrow backend changes separately; verify actual staging schema/RLS first. No automatic main merge or production deployment. |
| High | Founder release approval and organization ownership | Rebrand first; then explicitly approve organization enrollment and public submission. |
| Medium | Privacy/age/export declarations | Audit shipping SDK data flows and third-party AI processing; complete actual disclosures, age-rating questionnaire and export-compliance answers. Do not copy unchecked answers. |

## Future organization setup — do not execute now

After founder approval: an authorized founder enrolls **Lynxr LLC as an
organization**, using its legal entity name, matching D-U-N-S record, business
website/contact information and authority to bind the company. The founder
accepts agreements and separately approves membership spending. Obtain the Team
ID after enrollment. Do not enroll under an individual's seller identity as a
shortcut. Invite individual engineering accounts with only necessary roles.

Register the final explicit App ID, Share Extension ID and shared App Group under
that organization. Create the iOS App Store Connect record against that bundle
ID (name, primary language, SKU, access). Configure organization distribution
signing for both targets; archive and validate in Xcode. Future distribution uses
manual public release, even after review approval. Upload, processing, TestFlight
validation, listing completion and review submission are separate observable steps.
None has occurred on this mission.

## Policy notes (check again before future submission)

Initial mobile functionality is free with no checkout or upgrade links. A future
paid digital unlock requires a fresh IAP review. Own-company email/password
login falls within Apple's 4.8 exception; adding third-party social login changes
that analysis. Review requires a functioning backend, accurate metadata and
reviewer access. Private AI output still needs an assessed safety/reporting flow;
this branch supplies reporting but is not a completed moderation operation.

Account deletion starts inside the app and discloses manual fulfillment within
30 days. Apple permits reasonable manual processing with a clear timeline and
completion confirmation; founders must operationalize it. Do not force users to
contact support to initiate deletion.

Future listing draft: name pending rebrand; category Productivity; subtitle
“From video link to script”; description should cover supported links, explicit
brand confirmation, asynchronous processing, script library and copying. Do not
promise guaranteed virality, ownership of third-party content, instant results,
automatic social publishing or editing features that do not exist. Age rating
and screenshots remain pending actual shipping behavior. No camera, microphone
or photo-library permission is needed for URL-only intake. Audit the merged SDK
privacy manifests and network behavior rather than assuming no data collection.

Current references: [Apple review rules](https://developer.apple.com/app-store/review/guidelines/),
[Account deletion](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion),
[Organization enrollment](https://developer.apple.com/programs/enroll/),
[D-U-N-S](https://developer.apple.com/help/account/membership/D-U-N-S),
[Export compliance](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/).
