// swift-tools-version: 6.2
//
// The macOS verification harness for `ios/Core`.
//
// `ios/Core/*.swift` imports no Expo (DECISIONS.md D16), which is what makes
// this possible: the same FoundationModels code that ships in the iOS module is
// compiled here and run against the **real on-device model** on a development
// Mac. Unit tests with a fake native module cannot tell us whether a
// `GenerationSchema` really decodes, whether a cancelled `ResponseStream`
// throws, or whether a tool-call continuation is resumed exactly once; this
// can, in a second, without a device.
//
// `Sources/Core` is a symlink to `../ios/Core`. SwiftPM refuses a target path
// outside the package root and silently ignores `sources:` entries that escape
// it, but it follows a symlinked source directory — and the files have to be in
// *this* target rather than a library one because everything in `ios/Core` is
// `internal`.
//
// Not shipped anywhere: `ios/OnDeviceLlm.podspec` excludes it from the pod, and
// package.json's `files` whitelist excludes it from the npm tarball.
//
// Run it with `npm run harness:apple` from the repo root.

import PackageDescription

let package = Package(
  name: "harness",
  platforms: [.macOS("27.0")],
  targets: [
    .executableTarget(
      name: "Runner",
      path: "Sources",
      sources: ["Runner", "Core"],
      swiftSettings: [.swiftLanguageMode(.v6)]
    )
  ]
)
