# Contributing

[Back to the README](README.md)

## Local setup

Install dependencies with `npm install`, then run the checks below before opening a pull request.
For bugs, include your OS, device, Expo / React Native versions, and a minimal reproduction.

## Repository layout and checks

```text
src/core/      types, provider interface, error taxonomy, context manager, router, MockProvider
src/openai/    Chat Completions-compatible provider
src/apple/     TypeScript half of the native provider
src/react/     hooks
ios/           Swift: OnDeviceLlmModule.swift (Expo glue) + Core/ (FoundationModels logic)
android/       stub module; on-device Android support lives in the companion package
harness/       Swift package that exercises the framework directly against the live model
example/       Expo dev-client app used as the manual test rig
starters/      standalone apps that install the published npm package
scripts/       check-isolation, fm acceptance
docs/          this documentation, plus the Phase 0 research under docs/research/
```

The gates, all runnable with no device:

```bash
npm run build          # tsc to build/
npm run typecheck      # tsc --noEmit
npm run lint           # eslint, including the core/openai isolation rule
npm run test           # vitest; integration tests skip when fm serve is unreachable
npm run check:isolation # walks the built import graph for react/react-native/expo/native
npm run check:pack     # verifies the published tarball's contents
```

Two more need real hardware or a real server:

- **`npm run harness:apple`** — a Swift package (`harness/`) that drives FoundationModels
  directly, outside React Native, and asserts against the live model: transcript
  round-trips, snapshot-to-delta conversion, cancellation, prewarming, token counting, the
  supported/unsupported schema constraint matrix, and a full tool round trip with a timeout
  and a mid-call cancel. Needs macOS 27 and a healthy model; it skips rather than fails
  when availability is `available` but generation is wedged. This is the regression
  test for a future OS widening or narrowing what the framework supports.
- **`npm run acceptance:fm`** — the Phase 1 acceptance script: a plain Node script
  importing only the **built** `core` and `openai` entry points, holding a multi-turn
  conversation with `fm serve`, streaming and non-streaming, and cancelling mid-stream. Run
  `npm run build` first. Exit code `2` means `fm serve` was unreachable and nothing was
  tested, which is the expected result when it is not running.

The example app (`example/`) is an Expo dev-client rig with a provider toggle
(`MockProvider` or the real router), a "simulate on-device unavailable" switch that moves
the conversation to the cloud provider on the next turn with history intact, a
structured-output demo, and a tool round-trip demo. It needs `npx expo run:ios`; no
deployment-target override is required, since the module links at the Expo template's
default target.

The [task-extraction starter](starters/task-extractor) is a separate consumer app.
Run `npm ci`, `npm run typecheck`, and `npm test` in that directory. It intentionally
uses a pinned npm release, with no aliases to `src/`, so it exercises the public
installation path. CI also bundles its iOS JavaScript. Follow the starter's device
checklist before claiming live model behavior or recording a demo.
