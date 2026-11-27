# Lynxr internal iOS MVP

Mission 009 continues PR #11's native companion into URL intake, explicit source/
brand confirmation, a server-owned generation queue, status/retry, script copying,
and a durable iOS Share Extension inbox. Public submission, paid Apple enrollment
and TestFlight are deferred until rebranding and founder approval.

Start with [verified results and limitations](launch/VERIFICATION.md),
[internal setup and device testing](launch/INTERNAL_TESTING.md), the
[server contract](launch/CONTRACT.md), and the [rebranding/release checklist](launch/REBRAND_AND_RELEASE.md).
The native module/plugin is committed source; `ios/` is reproducible generated
output. Use Xcode's **Sign to Run Locally** for simulator Keychain access; an
unsigned compile alone is insufficient to validate session persistence.

Mobile reads existing `lynxr_creators.data` but never writes it. New brands and
jobs live in separate server-owned tables. Client RPCs derive ownership from Auth;
worker-only RPCs fence results with leases. The migration defaults the queue off
and serializes the existing allowance function for all callers. Applying it and
running the worker in any hosted environment require separate CTO approval.
Existing website, agency products and production worker behavior remain unchanged.

Email/password sessions retain PR #11's AES-GCM ciphertext in AsyncStorage and
device-only keys in SecureStore. Account-keyed providers reject late requests.
The transport allowlist permits creator reads, password/refresh/logout and six
specific owner RPCs; it never permits creator-document mutations, billing,
storage or worker calls. Database grants, owner checks and RLS are the actual
server boundary, not the TypeScript types or transport guard.

The App Group stores only links, owner identifiers and creation times, using
atomic files under a cross-process lock. It stores no auth token, video or script.
Sharing does not auto-submit or force-open the host app: the creator opens Lynxr
and confirms their account/brand/rights/AI processing. Repeated confirmed requests
use an encrypted outbox and server idempotency/deduplication. Polling resumes on
foregrounding; processing is independent of the phone's process lifetime.

`npm test` and `npm run typecheck` run without environment configuration.
`mobile/backend/tests` exercises an explicitly named disposable local Postgres
container and injected worker processing. `mobile/native-tests` runs actual
XCUITest flows against the local Auth/queue stack. See launch documentation for
observed results and remaining live-pipeline/physical-device gates. Injected test
output is never evidence of live extraction or generated script quality.

The confidential operating agreement and handoff remain outside this branch.
No missing Schedule B acceptance criterion is inferred. This is an internal MVP
engineering increment, not contractual milestone acceptance or public-release
approval.
