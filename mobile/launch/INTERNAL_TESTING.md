# Internal iOS MVP — no public distribution

Founder revision, 2026-11-27: App Store submission, paid enrollment and TestFlight
are deferred until rebranding and explicit founder approval. Nothing in this
branch is a production deployment. The app uses the existing email/password
flow; approved synthetic test accounts suffice for this internal release.

## Local setup (Mac, Docker, Xcode)

Use Node 22.13+, Python 3, Docker Desktop, Xcode with an iOS simulator runtime,
and CocoaPods. Run from the repository root unless a step says otherwise.

1. `npm --prefix mobile ci`
2. Start Docker Desktop. Start the isolated stack:
   `npm exec --yes --package supabase@3.4.0 -- supabase start --workdir mobile/backend --exclude realtime,storage-api,imgproxy,studio,postgres-meta,edge-runtime,logflare,vector,supavisor`
   Prefer `python3 mobile/tools/start_local.py` to suppress LOCAL keys. Do not paste keys into issues, screenshots or logs.
   Ports 54420–54429 and project `lynxr-ios-local` distinguish this stack.
3. On a **fresh** disposable stack, run
   `python3 mobile/backend/tests/bootstrap_local.py`. It reads checked-in creator,
   staff (without the staff seed), allowance and billing contracts, then the new
   migration. It refuses reinitializing an existing mobile schema. It cannot
   target a remote database. It does not run legacy `schema.sql` or read `.env`.
4. `python3 mobile/tools/seed_local.py` creates the disposable `.invalid` test
   account and enables this LOCAL queue. The intentionally public test login is
   defined in that script; it has no validity outside this local stack.
5. In another terminal: `python3 mobile/tools/local_processor.py` starts the
   **injected test processor**. Its output explicitly says it is neither video
   extraction nor AI generation. `Unavailable` in a test URL simulates access
   failure. No video is fetched, model called or real allowance charged.
6. From `mobile/`: `python3 tools/local_env.py npx expo start --localhost --port 8081`.
   This wrapper obtains only the local public configuration without writing a
   config/key file. A visible banner identifies this test build.
7. From `mobile/`: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer npx expo prebuild --platform ios --no-install`.
   Then `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer pod install --project-directory=ios`.
8. Build with Xcode (`mobile/ios/Lynxr.xcworkspace`) or CLI:
   `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -workspace mobile/ios/Lynxr.xcworkspace -scheme Lynxr -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath mobile/.build CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=- build`.
   Install `mobile/.build/Build/Products/Debug-iphonesimulator/Lynxr.app` using
   `xcrun simctl install <simulator-UDID> <app-path>` and launch `io.lynxr.mobile`.
   Set DEVELOPER_DIR for simctl too when xcode-select points to Command Line Tools.

For a standalone simulator build that does not require Metro after installation,
run from `mobile/`:

```sh
python3 tools/local_env.py xcodebuild -workspace ios/Lynxr.xcworkspace -scheme Lynxr -configuration Release -destination 'generic/platform=iOS Simulator' -derivedDataPath .build -hideShellScriptEnvironment CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=- build
```

Install `.build/Build/Products/Release-iphonesimulator/Lynxr.app` with simctl.
This is **simulator-only**, ad-hoc “Sign to Run Locally”; it is not a signed device
IPA or distribution build. Local Auth/queue services must remain running. The
embedded local-test configuration and banner remain visible. Do not distribute
this build as a production app. An unsigned build compiles but lacks the
simulated Keychain entitlement; leave local signing enabled when running tests.

Generated `ios/`, build output, credentials, database state and `.env` are ignored.
Do not use `db push`, `link`, remote CLI targets, or production keys for this test.
Tests create/delete only explicitly named disposable local Auth users.

## Native UI tests

With the local test environment running, `node mobile/tools/add_ui_tests.js`
adds a test target to generated iOS output. Then run xcodebuild with scheme
`LynxrLocalTests`, a concrete simulator destination and `test`. The Swift test
source is `mobile/native-tests/LynxrUITests.swift`. Keep Metro running with the
local wrapper and avoid changing app files during a run (Fast Refresh resets
form state). XCUITest attachments provide screenshots of actual native screens.

The separate `ShareTestHost` is a local SwiftUI sender with no App Group,
credentials or network code. Build its target with the simulator SDK and install
`ShareTestHost.app` using simctl before running the share test. It shares plain
text through the actual iOS activity sheet into Lynxr's extension. This exercises
another app's handoff without installing Instagram or opening a video. Actual
Instagram/TikTok host-app attachment formats still need physical testing.

## Free Apple Account installation on iPhone

No paid membership or App Store record is required for personal Xcode testing.
The founder performs Apple sign-in and any agreements; do not send credentials.

1. Connect an iPhone by USB, unlock, trust the Mac and enable Developer Mode
   when iOS requests it. Pair it in Xcode's device controls. Install matching
   device support if required. No iPhone was connected during initial setup.
2. Xcode → Settings → Accounts → add the founder's free Apple Account. Choose
   the Personal Team for development only. Do not create a personal App Store app.
3. Use a temporary development bundle ID, e.g.
   `LYNXR_BUNDLE_ID=io.lynxr.mobile.dev.<founder>` when prebuilding. Preserve
   `io.lynxr.mobile` as the provisional future organization identifier. The
   plugin derives extension ID `<bundle>.share` and App Group `group.<bundle>.share`.
4. Enable automatic signing on **both** app and Share Extension targets, select
   that Personal Team, and let Xcode manage the development profiles. Verify
   that the exact App Group is present on both profiles. Apple's current
   capability matrix includes App Groups for free Apple developers; actual
   provisioning must be verified with this account. No free signing succeeded
   here because no account/signing identity or iPhone is available.
5. Use an approved HTTPS staging backend when available. For disposable local
   accounts only, use the Mac's private LAN IPv4 address:
   `python3 tools/local_env.py --device-host 192.168.x.x npx expo start --lan`.
   The iPhone and Mac must share the network; allow the app's local-network
   prompt. Do not send real credentials over this local HTTP test connection.
   The local flag permits only loopback/RFC1918 IPv4 hosts, not public HTTP.
6. Select the iPhone in Xcode and Run. Approve developer trust if iOS requests it.
   After each development profile expires, rebuild/reinstall (Apple documents
   seven-day expiry, up to three devices and three installed apps per device).
7. If this account cannot provision the App Group, retain that explicit blocker.
   `LYNXR_PERSONAL_TEAM=1` before a **clean** prebuild creates a paste-only
   development build without the extension; this is not full share-flow validation.
   Do not use private URL-opening tricks to bypass the entitlement.

Device checklist: sign in, incorrect password, lock/unlock, terminate/relaunch,
refresh after backgrounding, paste IG/TikTok variants, share text/URL from actual
host apps, cancel share, signed-out share, switch accounts, duplicate shares,
network loss before/after submission, inaccessible source, retry, copy/library,
sign out, deletion request, large text and VoiceOver. Test at least one small
screen. Distinguish local test-processor output from a real pipeline run.

## Real extraction/generation gate

The opt-in runner `mobile/backend/mobile_worker.py` reuses `fill_source`,
`extract_format`, `fill_adaptation` and `has_usable_result`. It does not invoke
legacy JSON grafts or shared-cache writes; mobile output stores text/structure
only, with preview-media uploads disabled. Alternate paid Apify fetch is disabled.
Worker credentials are runtime environment variables, never Expo variables.

Before a real run: CTO reviews the migration and worker; approve a nonproduction
project and verify its actual schema/RLS, authorized test account and licensed
source; separately authorize the model spending budget; configure provider
credentials privately. The CLI refuses the known production project and requires
`--approved-nonproduction-origin` plus `--allow-paid-processing`. Do not pass the
flag until spending is authorized. One invocation claims one job; operate it as
an opt-in runner, not an undeclared change to the production worker.

A complete paid-provider end-to-end test is still required. Stubbed local tests
prove integration and recovery, not live source access, generated quality, cost
or latency. Do not turn on the server flag for real users until that gate passes.

References checked 2026-11-27:
[Apple free account and expiry](https://developer.apple.com/help/account/basics/about-your-developer-account),
[Apple capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios),
[Expo extensions](https://docs.expo.dev/build-reference/app-extensions/),
[Supabase functions](https://supabase.com/docs/guides/database/functions).

## Build-tool dependency note

The SDK-compatible versions are locked. A narrow `@expo/fingerprint` override
pins `minimatch` 11.0.1 to address GHSA-g3hv-75wg-m249, rather than accepting npm's
suggested downgrade to an older Expo SDK. The fingerprint API, dependency check,
native build and tests are verified after the override. The audit reports zero
vulnerabilities for this lockfile. Reassess when Expo updates that dependency.
