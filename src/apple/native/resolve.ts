/**
 * Lazy native-module resolution (docs/plan.md §4, §5 Phase 3 step 8).
 *
 * The package root re-exports this provider, so **importing it must never
 * throw** — not on Android, not on web, not in a Node test runner, not on an
 * iOS build without the framework. That rules out the scaffold's
 * module-scope `requireNativeModule(...)`: that call throws at import time on
 * every platform but iOS, and taking the package root down with it.
 *
 * So nothing is resolved until a provider method actually needs the module,
 * the resolution is wrapped in `try`/`catch`, and a failure is a `undefined`
 * that the caller reports as `unsupportedPlatform`.
 *
 * `require` rather than `import`: resolution has to be synchronous inside a
 * method body, and the build output is CommonJS (see tsconfig's `module`
 * comment), which is also how Metro loads this package.
 */

import type { AppleNativeModule } from './types';

/**
 * Present in CommonJS (the compiled output) and in Metro's module wrapper;
 * absent under a raw ESM loader. Declared rather than pulled from
 * `@types/node`, which this package does not depend on.
 */
declare const require: ((id: string) => unknown) | undefined;

interface ExpoModuleNamespace {
  requireNativeModule?: (name: string) => unknown;
}

interface ReactNativeNamespace {
  Platform?: { OS?: string };
}

/** `null` = resolution has been attempted and failed. `undefined` = not attempted. */
let cached: AppleNativeModule | null | undefined;

/**
 * `true` only when `react-native`'s `Platform.OS` says `'ios'`.
 *
 * Defense in depth: only the Swift module may answer on iOS; nothing but
 * `Platform` can prove where we are. Duck-typing (`isUsable` below) can only
 * check the shape of whatever `requireNativeModule('OnDeviceLlm')` hands
 * back, not which platform handed it back — and this package's own template
 * stub (`android/src/main/java/expo/modules/ondevicellm/OnDeviceLlmModule.kt`)
 * registers that exact same name on Android, with no functions today. The
 * separately-packaged on-device Android provider
 * (`@taaltreelabs/on-device-llm-android`) registers under a different name
 * (`OnDeviceLlmAndroid`) precisely to avoid ever colliding with this one, but
 * this gate does not depend on that naming choice holding forever. Do not
 * remove this in a refactor because `require('react-native')` looks
 * unidiomatic — it is the load-bearing check.
 *
 * Never throws: a Node test runner and a raw ESM loader both fail to resolve
 * `react-native` at all, which this treats identically to "not iOS".
 */
function isIosPlatform(): boolean {
  try {
    if (typeof require !== 'function') return false;
    const reactNative = require('react-native') as ReactNativeNamespace;
    return reactNative?.Platform?.OS === 'ios';
  } catch {
    return false;
  }
}

/**
 * Is this object actually our module, rather than a same-named stub?
 *
 * `android/src/main/java/expo/modules/ondevicellm/OnDeviceLlmModule.kt`
 * registers the name `OnDeviceLlm` with no functions at all (the Android
 * provider is the §9 stretch goal). So `requireNativeModule('OnDeviceLlm')`
 * *succeeds* on Android and hands back an object whose methods are all
 * `undefined`. Checking for the functions we are about to call is what turns
 * that into a clean `unsupportedPlatform` instead of a
 * `TypeError: native.availability is not a function` at the first request.
 */
function isUsable(candidate: unknown): candidate is AppleNativeModule {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const module = candidate as Record<string, unknown>;
  return (
    typeof module['availability'] === 'function' &&
    typeof module['capabilities'] === 'function' &&
    typeof module['generate'] === 'function' &&
    typeof module['startStream'] === 'function' &&
    typeof module['cancel'] === 'function' &&
    typeof module['addListener'] === 'function'
  );
}

/**
 * The Swift module, or `undefined` on any platform that does not have it.
 *
 * Never throws. The result is cached, including the failure — a platform does
 * not grow a native module between calls, and retrying a `require` that
 * throws on every request is pure overhead.
 */
export function resolveNativeModule(): AppleNativeModule | undefined {
  if (cached !== undefined) return cached ?? undefined;
  cached = null;
  try {
    if (!isIosPlatform()) return undefined;
    if (typeof require !== 'function') return undefined;
    const expo = require('expo') as ExpoModuleNamespace;
    if (typeof expo?.requireNativeModule !== 'function') return undefined;
    const candidate = expo.requireNativeModule('OnDeviceLlm');
    if (isUsable(candidate)) {
      cached = candidate;
      return candidate;
    }
  } catch {
    // Expected on Android, web, Node, and any iOS build without the module.
    // Deliberately silent: this is a supported state, not an error, and the
    // caller turns it into `unavailable`/`unsupportedPlatform`.
  }
  return undefined;
}

/**
 * Test seam. Not exported from `src/apple/index.ts`, and not part of the
 * public API: unit tests import it from this path directly. Pass `undefined`
 * to simulate a platform without the module, or `null` to clear the cache and
 * resolve for real again.
 */
export function __setNativeModuleForTests(module: AppleNativeModule | undefined | null): void {
  cached = module === null ? undefined : (module ?? null);
}
