# Troubleshooting

[Back to the README](../README.md)

## Availability says available but every generation fails

**Symptom.** `availability()` reports `{ available: true }`, `capabilities()` reports
`contextWindow: UNKNOWN` (the framework returned `0`), and every `generate`/`stream` fails
with an `unknown` error whose `cause` mentions `SensitiveContentAnalysisML error 15` or
`ModelManagerError 1013`. Token counting throws too.

**What it is.** The on-device model stack is wedged. This is observed behavior on a
development Mac, not a hypothetical: availability is a check on configuration, not a
health check, which is why the documentation repeats that `available: true` means "nothing
known is blocking", never "the next request will succeed".

**Remedies, in order of increasing disruption.** Wait — it often clears itself within
minutes. Toggle Apple Intelligence off and back on in Settings. Reboot the device or Mac.
On a Mac, confirm that the model assets are actually present rather than mid-download.

**Why the package behaves the way it does.** Untyped `NSError`s from the native layer map
to `unknown` with `transient: true` rather than crashing the request path, and
`unknownTransient` is a fallback trigger that is **on** by default — so a router with a
cloud provider configured routes around a wedged stack instead of failing the user's turn.
This is the entire reason that lane exists in the taxonomy. If you are running a single
Apple provider with no fallback, you will see the raw error; that is the honest outcome.

## The native module is missing at runtime though the build was green

**Symptom.** The app builds with no errors and no warnings, and then
`createAppleProvider()` reports `unsupportedPlatform` on a device that should support the
model, or `requireNativeModule('OnDeviceLlm')` fails outright.

**Cause.** `expo-modules-autolinking` filters modules by deployment target. The podspec
now declares iOS 16.4 — `ExpoModulesCore`'s own floor and the Expo
template's default — so this only bites an app whose own deployment target is set
_below_ 16.4. If your app's Podfile platform is lower than that, `pod install`
**silently omits the module entirely**: `Podfile.lock` has no entry for it, and the build
succeeds because nothing referenced it. This is unrelated to the on-device model's own
iOS 26 floor — a device below 26 still links the module and gets `unsupportedPlatform`
from it at runtime, which is the working, intended fallback path (see
[What differs on iOS 26](compatibility.md#what-differs-on-ios-26)).

**Fix.** Raise your app's deployment target to at least `16.4` (via `expo-build-properties`
in `app.json`, or your Podfile directly), then reinstall pods. Raise the app target's own
`IPHONEOS_DEPLOYMENT_TARGET` too, or the app's Swift fails to compile with a "module
'OnDeviceLlm' has a minimum deployment target of iOS 16.4" error. Check `Podfile.lock` for
an `OnDeviceLlm` entry as the confirmation step — a green build is not one.

## The app crashes at launch with "UIScene life cycle is required"

**Symptom.** A new Expo app builds and installs, then closes immediately on launch — on a
device and in the Simulator alike — with this in the logs:

```text
Application failed to launch: UIScene life cycle is required for apps built with this SDK.
```

**Cause.** Not this package: apps built with the iOS 27 SDK must use UIKit's scene-based
life cycle, and the Expo 57 `prebuild` template still starts React Native from the
`AppDelegate` with no scene. Any Expo 57 app built with Xcode for iOS 27 hits it, with or
without this library.

**Fix.** Add the package's config plugin to `app.json` and prebuild again. It applies the
patch below for you:

```json
{
  "expo": {
    "plugins": ["@taaltreelabs/on-device-llm"]
  }
}
```

```bash
npx expo prebuild --platform ios --clean
```

The plugin only changes an `AppDelegate.swift` it recognises as Expo's template, and it is
safe to run again. If yours has been customised, `prebuild` prints a warning from
`@taaltreelabs/on-device-llm` and leaves the file alone. Then make these three changes in
`ios/<YourApp>/` by hand — the same edits the plugin makes:

1. In `AppDelegate.swift`, adopt `ExpoReactNativeFactoryProvider` and stop starting React
   Native yourself — build the factory, keep it, and let the scene delegate start it:

   ```swift
   @main
   class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
     var window: UIWindow?

     var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
     var reactNativeFactory: RCTReactNativeFactory?
     var reactNativeFactoryModuleName: String { "main" }

     public override func application(
       _ application: UIApplication,
       didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
     ) -> Bool {
       let delegate = ReactNativeDelegate()
       let factory = ExpoReactNativeFactory(delegate: delegate)
       delegate.dependencyProvider = RCTAppDependencyProvider()

       reactNativeDelegate = delegate
       reactNativeFactory = factory

       // No window and no startReactNative(...) here: SceneDelegate does both.
       return super.application(application, didFinishLaunchingWithOptions: launchOptions)
     }

     // ...the template's Linking and Universal Links overrides stay as they are.
   }
   ```

2. Add a scene delegate. Put it in a new `SceneDelegate.swift` added to the app target, or
   at the bottom of `AppDelegate.swift` so the Xcode project needs no new file:

   ```swift
   class SceneDelegate: ExpoAppSceneDelegate {}
   ```

3. Declare the scene in `Info.plist`:

   ```xml
   <key>UIApplicationSceneManifest</key>
   <dict>
     <key>UIApplicationSupportsMultipleScenes</key>
     <false/>
     <key>UISceneConfigurations</key>
     <dict>
       <key>UIWindowSceneSessionRoleApplication</key>
       <array>
         <dict>
           <key>UISceneConfigurationName</key>
           <string>Default Configuration</string>
           <key>UISceneDelegateClassName</key>
           <string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>
         </dict>
       </array>
     </dict>
   </dict>
   ```

Then rebuild (`npx expo run:ios`). A JavaScript reload is not enough, because this is native
code. Without the plugin, `npx expo prebuild --clean` regenerates `ios/` from the template
and discards a hand-applied patch, so re-apply it after a clean prebuild.

## `fm serve` behaves oddly during local development

Apple's `fm` CLI ships a Chat Completions-compatible server that is genuinely useful for
testing this package's `openai` provider from Node against a real model, with no device
and no cloud account. It is a **local development rig only, never a shipping dependency**:
the macOS 27 license text arguably forbids programmatic use in a shipped product, and the
binary is nowhere near the published package. With that said, its quirks:

- **Every response is SSE**, even when the request does not set `stream: true`. The
  `openai` provider detects a `text/event-stream` content type on a non-streaming request
  and parses it anyway.
- **Errors arrive in band**, as a frame inside an otherwise-successful `200` stream,
  rather than as an HTTP status. The provider raises them as `LLMError`s from the
  iterator.
- **It binds to loopback only**, port 1976 by default. A simulator can reach
  `127.0.0.1`; a physical device cannot, and needs the Mac's LAN address — the example app
  derives it from `Constants.expoConfig.hostUri`.
- **`tool_choice` is broken upstream.** Auto mode never populates `tool_calls`, and a
  forced choice is rejected outright. Do not use `fm serve` to test tool calling; use the
  Apple provider and the Swift harness.
- **Recursive `$defs` hang the server permanently**, for every later request too, until
  the process is restarted. The schema normalizer rejects recursive `$ref` before a
  request is ever built, which is one of the things that rejection buys you.
- **`max_tokens` is ignored**, and the context window on the audited build is 4096 tokens.

Integration tests that target `fm serve` skip cleanly when it is not reachable, so a
normal `npm run test` needs nothing running.

## Metro cannot resolve the subpath exports

Metro has resolved `package.json` `exports` by default since React Native 0.79, so on the
supported floor (RN 0.86 / Expo SDK 57) the five entry points resolve with no
configuration. If you have opted out with `unstable_enablePackageExports: false`, turn it
back on; there is no proxy-directory fallback and none is planned.

If you are working against a local checkout the way `example/` does — Metro
`extraNodeModules` pointing at the repo, `watchFolders` including it — watch for the
**nested-resolution trap**: `babel.config.js`'s `require('babel-preset-expo')` walks _up_
out of the app's own `node_modules` and can find an older copy at the repo root, paired
with an older React Native. The symptom is an unrelated-looking transform failure such as
_"Unable to determine event arguments for onModeChange"_, and `expo export` fails outright.
The fix is to add `babel-preset-expo` to the app's own `devDependencies`, pinned to the
version its `expo` depends on, so local resolution wins.
