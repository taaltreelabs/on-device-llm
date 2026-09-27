require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'OnDeviceLlm'
  s.version        = package['version']
  s.summary        = 'On-device LLMs for React Native and Expo, with automatic cloud fallback and context window management.'
  s.description    = package['description']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.license        = package['license']
  # Platform floor: iOS 16.4, the floor of ExpoModulesCore itself
  # (`ExpoModulesCore.podspec`), not the floor of FoundationModels. Expo
  # autolinking silently drops any pod whose platform is above the app's
  # deployment target, and the Expo template's default
  # target is 16.4, so a higher floor here would make every app that still
  # supports older iOS lose the module without a build error. This supersedes
  # the previous iOS 27 floor.
  #
  # FoundationModels is iOS 26.0, so on this floor it is weak-linked (below)
  # and nothing touches it before a runtime check: every `AsyncFunction` in
  # OnDeviceLlmModule.swift checks `#available(iOS 26.0, *)` first and reports
  # `unavailable` / `unsupportedPlatform` on older iOS, and everything in
  # ios/Core that names a FoundationModels type is `@available(iOS 26.0, *)`.
  # iOS 26.x API gaps (the iOS 26 error taxonomy, no usage reporting below 27,
  # token counting from 26.4) are handled inside ios/Core with `#available`
  # checks. docs/research/ios26-compat.md has the details and the evidence.
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: package['repository'] + '.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Weak-link FoundationModels, so an app running on iOS older than 26 (where
  # the framework does not exist) still launches: dyld skips a missing weak
  # dylib instead of aborting the process, and the `#available` checks above
  # keep every reference to it unreached. The toolchain already gets there on
  # its own: Swift emits every reference to a symbol newer than the deployment
  # target as a weak reference, and the linker weak-links a dylib when all
  # references into it are weak (measured: 203 of 203 in libOnDeviceLlm.a).
  # So today this line states the intent rather than changing the load
  # command, and it guards against the day one strong reference slips in, or
  # a toolchain or build setting stops doing it (docs/research/ios26-compat.md).
  s.weak_frameworks = 'FoundationModels'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  # Everything under ios/, and nothing else. The macOS verification harness
  # (../harness) compiles ios/Core/*.swift through a symlink, so it must never
  # be picked up here: its runner is a `main.swift` executable and an app that
  # linked it would fail to build. The glob is already rooted at this
  # directory, which makes that true today; the exclusion states it, so a
  # future `s.source_files` widened to the repo root cannot break it silently.
  s.source_files  = "**/*.{h,m,mm,swift,hpp,cpp}"
  s.exclude_files = ["../harness/**/*", "**/.build/**/*"]
end
