# Internal MVP verification — 2026-11-27

Decision: ready for review and disposable local simulator testing. **Not ready
for public release or real-user generation.** No hosted migration, production
write, paid inference, Apple enrollment, TestFlight upload or submission occurred.

## Observed results

| Check | Result | What the evidence establishes |
|---|---|---|
| TypeScript | Passed | Native client and routes type-check. |
| Node mocked integration tests | 20/20 passed | Password/refresh/logout transport, encrypted persistence, account-change fences, URL validation, RPC allowlist and durable submission replay. |
| Local Postgres + injected worker | 12/12 passed | Actual database grants, owner/staff/anonymous boundaries, concurrent last-credit behavior across legacy/mobile callers, deduplication, payload conflicts, brand ownership, unchanged creator JSON, refunds, retries, lease fencing, expiry and deletion cascades. |
| Native Swift URL parser | 11 cases passed | Supported link extraction and rejection of unsupported hosts/paths. |
| Native XCUITest suite | 4/4 passed | Local email Auth, Keychain-backed session recovery after termination, submission/status/library/copy, a separate app's real share sheet into the extension, and switching A → B → A without A's scripts/inbox appearing for B. |
| Share layout retest | 1/1 passed after layout fix | Full saved-link confirmation and Done button visible; inbox restored after cold launch. |
| Debug and Release simulator builds | Passed | Native app and embedded Share Extension compile and sign locally. |
| Standalone Release launch | Passed | Installed and launched with Metro stopped; authenticated library loaded from local services with embedded JS bundle. |
| Existing offline repository gate | 30/30 passed | `uv run --with anthropic --with certifi python tools/fixer/run_tests.py`; no provider calls. FFmpeg was installed for the existing media checks. |
| Hygiene | Passed | Ruff for mobile Python, stamp checker, diff whitespace, Expo dependency compatibility and npm production audit (zero vulnerabilities at verification). |

Host: Apple Silicon Mac, Xcode 27.2 (27B52), iOS 27.2 (24B8117), iPhone 17 Pro
simulator. Local Supabase CLI 3.4.0 and Docker serve only disposable `.invalid`
accounts on ports 54421/54422. The queue is enabled only in this isolated stack.

Xcode emitted a diagnostic-collection warning because global `xcode-select`
points to Command Line Tools. Test execution itself reported **TEST SUCCEEDED**.
Commands explicitly set `DEVELOPER_DIR`; the global developer directory was not
changed. No physical-device result is inferred from the simulator.

The local processor is deliberately injected and labelled. Its script text says
“LOCAL TEST OUTPUT” and states it is neither extraction nor AI generation. These
results establish orchestration, authorization and recovery, not source access,
model output quality, model latency or cost. Only disposable allowance rows were
created/charged/refunded. No real creator records or external videos were read.

## Reproduce

Follow [INTERNAL_TESTING.md](INTERNAL_TESTING.md) for the local stack, bootstrap,
seed, Metro and native prebuild. Stop the injected processor while running the
database tests, then rerun the seed script to re-enable the disposable queue and
restart that processor. Tests temporarily disable the local queue during cleanup.

```sh
npm --prefix mobile test
npm --prefix mobile run typecheck
python3 -m unittest discover -s mobile/backend/tests -p 'test_*.py' -v
uvx ruff check mobile/backend mobile/tools
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swiftc mobile/plugins/LinkParser.swift mobile/native-tests/parser/main.swift -o mobile/.build/url-parser-tests
mobile/.build/url-parser-tests
node mobile/tools/add_ui_tests.js
```

Build and install the independent sender before the UI suite:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project mobile/ios/Lynxr.xcodeproj -target ShareTestHost -configuration Debug -sdk iphonesimulator SYMROOT="$PWD/mobile/.build/Build/Products" CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=- build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl install <UDID> mobile/.build/Build/Products/Debug-iphonesimulator/ShareTestHost.app
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -workspace mobile/ios/Lynxr.xcworkspace -scheme LynxrLocalTests -configuration Debug -destination 'platform=iOS Simulator,id=<UDID>' -derivedDataPath mobile/.build -resultBundlePath mobile/.build/LocalTests.xcresult CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=- test
```

Use a fresh result-bundle path for each run and run Xcode operations sequentially
when they share DerivedData. The UI suite uses the seed script's public,
local-only test password. It dismisses iOS's password-save suggestion rather than
saving that credential to an Apple account. It uses synthetic video URLs without
opening or downloading them. Repeated submissions also exercise server deduplication.

The generated native project and `.xcresult` bundles stay in ignored build output.
The local Release artifact is `.build/artifacts/Lynxr-local-simulator.zip`,
accompanied by a SHA-256 checksum. It is a simulator `.app`, **not** a device IPA.
Rebuild it using the local wrapper when the local stack's public configuration
changes. Local backend services must remain running; Metro is unnecessary for
that Release artifact. No private/service key is embedded in it.

## Actual screenshots

- [Standalone Release library](screenshots/standalone-library.png), captured with Metro stopped.
- [Native Share Extension](screenshots/native-share.png), captured from XCUITest's independent sender.
- [Local test script and native Copy](screenshots/local-script-copy.png), captured from XCUITest.

These images show synthetic local test records in the real native interface.
They are not examples of real generated scripts or public store assets.

## Remaining verification

**Critical:** real extraction/generation remains unexecuted. Approve a separate
nonproduction backend, licensed source, authorized test account and bounded
provider spending before using the opt-in real processor. Its function-reuse
tests do not validate a provider's current runtime contract or media access.

**High:** no iPhone or free Apple Account signing identity was available. Execute
the documented USB/Personal Team procedure, both-target/App Group provisioning,
actual Instagram/TikTok share formats, lock/background/network interruption,
accessibility and small-screen checks. Account deletion/report operations need
an assigned operator and staging rehearsal; a request is not completed deletion.

**Medium:** Android's native build and incoming-share handling are outside this
iOS verification. Android retains paste intake; the iOS extension is platform
specific. Exhaustive crash/refresh-token expiry, every host-app attachment shape
and physical-device clipboard behavior remain unverified. Review real staging
RLS and current dependency/privacy manifests before release.

See [REBRAND_AND_RELEASE.md](REBRAND_AND_RELEASE.md) for founder approval,
rebranding and later organization-owned public distribution gates. Do not merge
or deploy this draft as part of the local test increment.
