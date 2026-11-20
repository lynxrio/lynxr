# Lynxr mobile companion · PR 1

An independent, read-only iOS and Android application for existing creator accounts. It signs in with email and password, restores an encrypted device session, signs out, and displays saved original and brand scripts from the existing Supabase backend.

The app has no script submission, retry, editing, onboarding save, profile update, allowance charge, billing, or publishing operation. It introduces no writer to `lynxr_creators.data`. Auth sign-in, token refresh and local-scope session revocation are the only supported POST requests.

## Run locally

Use Node 22.13+ and npm. From `mobile/`:

```sh
npm ci
npm test
npm run typecheck
cp .env.example .env.local
npm start
```

For an interactive connected preview, use an isolated development Supabase project and synthetic accounts. Set `EXPO_PUBLIC_SUPABASE_URL` to its HTTPS origin and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to its publishable key. With no configuration, the app shows a setup message. Configuration is unnecessary for automated tests. Never put an admin, service-role, secret key or password in Expo public variables. No production endpoints or credentials are embedded.

## Architecture and boundaries

- **Routing and account isolation:** Expo Router guards the sign-in and creator routes. A creator’s library provider is keyed by the signed-in user ID; signing out removes that route tree. The read service checks the current session before and after every request and rejects results after an account switch. The per-account store invalidates late refreshes on cleanup and supports React StrictMode effect replay.
- **Read-only data access:** `creator-api.ts` reads only the signed-in creator’s `id,data,updated_at` from `lynxr_creators`. Its database types do not permit insert/update. A request allowlist additionally rejects every non-GET Data API call, other tables, RPCs, Edge Functions, storage operations and unknown Auth paths before fetch. This prevents accidental writes in this client; existing Supabase RLS remains the server authorization boundary.
- **Session storage:** AES-GCM ciphertext lives in AsyncStorage. Only the encryption key lives in Expo SecureStore, using iOS device-only accessibility while unlocked. This avoids native secure-value size limits for large sessions. Locked/unavailable storage produces a recoverable startup error without exposing the underlying exception. Missing keys or damaged ciphertext start signed out. Script data stays in memory and is never written to a device cache.
- **Authentication redirects:** Email/password sign-in uses the existing Supabase Auth account and needs no redirect configuration. Signup, email confirmation, recovery, Google-only sign-in and OAuth remain outside this slice. The provisional app scheme and bundle IDs are for development; they do not establish approved store identities or native auth links.
- **Refresh and background behavior:** Token refresh runs while foregrounded and pauses in the background. The library refreshes on foregrounding, every 15 seconds when work is active, otherwise every 60 seconds, and on explicit refresh. A read failure keeps only that account’s prior in-memory snapshot and shows an error. The server worker continues independently; the companion never invokes it.

The list comes from active `data.adaptations`, not trash or separate agency deliveries. Status labels map the actual `queued/running/done/error` contract and distinguish worker-scheduled retries. Original scripts use `source.script.segments` and `source.shots`; brand scripts use the saved `adaptation.hook/beats/cta/caption`, including existing edits. Text is selectable. No allowance RPC is needed for this read-only workflow.

## Provisional dependency map

The confidential draft Operating Agreement and engineering handoff have not been privately supplied. They remain outside this repository. Schedule B defines proposed milestones, but its missing acceptance criteria are not inferred here. The following code-derived dependencies are provisional until those documents and product decisions are available:

| Dependency | Repository evidence | Remaining dependency |
| --- | --- | --- |
| Existing email/password accounts | `creator.js` Auth password and refresh contracts | Isolated synthetic test accounts; actual hosted Auth behavior not exercised |
| Creator-owned library reads | `supabase/schema.sql`, `creator_tables.sql`: creator row RLS uses `auth.uid() = id` | Verify deployed RLS and table exposure in an isolated project |
| Saved script shapes | `creator.js` script views and `pipeline/process_adaptations.py` results | Future shared-contract changes need a documented decision |
| App identity and native distribution | Provisional Expo scheme/bundle identifiers in `app.json` | Owner-approved identifiers, signing and store requirements |
| Milestone acceptance | Not established by code or this PR | Privately supplied Schedule B and engineering handoff |

## Test evidence and limitations

`npm test` runs 15 deterministic checks using the real Supabase JS client against an in-memory HTTP fixture. The mock accepts only its reserved `.invalid` host and expected sign-in, refresh, sign-out and creator GET paths. Every Data API mutation fails immediately. Tests cover sign-in rejection, large Unicode encrypted-session persistence and restart, token refresh, sign-out and account switching, late responses, missing keys, damaged ciphertext, locked storage recovery, owner checks, empty/error reads, original/brand script presentation, refresh ordering and store cleanup/reactivation. Route guards and account-keyed providers were reviewed in source; rendered route behavior has not been tested.

TypeScript, `expo install --check`, and Metro exports for iOS and Android verify dependency compatibility and JavaScript/native bundle generation. No production data, paid inference or script charging occurs. Mock ownership tests do not execute Postgres RLS.

Not yet verified on physical devices: rendered screens and route transitions, Keychain/Keystore behavior through lock/reinstall/restore, foreground token refresh, sign-out failure recovery, VoiceOver/TalkBack, keyboard/password autofill, small displays and large text. Native binaries were not built or installed. Before connecting real accounts, verify these behaviors and actual authorization in an isolated environment. This is a bounded engineering slice, not a claim of Schedule B acceptance.

References: [Supabase React Native Auth](https://supabase.com/docs/guides/getting-started/tutorials/with-expo-react-native), [Expo SecureStore](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/), [Expo Crypto](https://docs.expo.dev/versions/v58.0.0/sdk/crypto/), [Expo protected routes](https://docs.expo.dev/router/advanced/protected/).
