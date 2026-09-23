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
  # Platform floor per DECISIONS.md D4: this module targets the current OS
  # release only. Older iOS (including 26, which shipped FoundationModels)
  # gets `unavailable` / `unsupportedPlatform` from the Apple provider, not
  # a compatibility code path.
  s.platforms      = {
    :ios => '27.0'
  }
  s.source         = { git: package['repository'] + '.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

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
