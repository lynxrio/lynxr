# Mobile launch contract (proposed, not deployed)

The free iOS MVP has no purchase, upgrade, checkout or paid-feature unlock flow.
The new queue defaults disabled. A reviewed backend deployment and operator
activation are required before mobile generation is available.

Mobile never writes `lynxr_creators.data`. It reads existing brands/scripts and
creates brands/jobs in separate server-owned tables. RPCs derive the owner from
Auth, reject staff/anonymous/deleted accounts, snapshot brand input and reserve
allowance transactionally. Every submission has a durable client request UUID;
replays with changed payload fail. Canonical URL + brand deduplication prevents
repeated taps/shares from consuming another credit. Retries reuse the same job.

The existing allowance implementation must acquire the same per-creator advisory
transaction lock for every caller before counting charges. This serializes the
last available credit across legacy web jobs and mobile jobs. Worker results
use a lease token; stale workers cannot finish another attempt. Failed jobs
refund their charge. Expired leases become interrupted failures, requiring an
explicit retry rather than automatically repeating paid inference.

Only service-role worker RPCs can claim/finish jobs. The opt-in mobile runner
reuses extraction and generation functions, never the legacy JSON graft writer.
No service key or inference credential enters the app. Tests inject processing
functions; they do not demonstrate a paid model's output quality or live source
availability.

Share Extension: supported URL/text attachments only, App Group durable files,
no auth token or video storage, no host-opening trick. The creator opens Lynxr,
confirms source/brand/rights/AI processing and submits. Session changes discard
other-owner inbox items. Unattributed signed-out shares require explicit review.
A persisted encrypted submission outbox survives lost responses and restarts.

Deletion is an in-app, idempotent request with a disclosed manual completion
window (existing privacy policy: within 30 days). Pending requests prevent new
mobile jobs. Operational fulfillment, billing cancellation where applicable and
completion notification must be assigned and rehearsed before release. A request
is never labelled as completed deletion.
