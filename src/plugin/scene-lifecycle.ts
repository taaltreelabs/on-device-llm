/**
 * The source transforms behind the config plugin, kept free of any Expo
 * import so they can be tested as plain string-in, string-out functions.
 *
 * Why this exists (DECISIONS.md D40, D41): apps built with the iOS 27 SDK must
 * use UIKit's scene-based life cycle, and the Expo 57 `prebuild` template
 * still starts React Native from `AppDelegate` with no scene, so every fresh
 * app crashes at launch with "UIScene life cycle is required for apps built
 * with this SDK". The fix is the hand migration verified on iOS 27 in D40:
 *
 * 1. `AppDelegate` adopts `ExpoReactNativeFactoryProvider` and names the
 *    module, so the scene delegate can find the factory it built;
 * 2. `AppDelegate` stops creating a window and starting React Native itself;
 * 3. a `SceneDelegate: ExpoAppSceneDelegate` does both from the connecting
 *    scene — declared in `AppDelegate.swift`, so the Xcode project needs no
 *    new file reference;
 * 4. `Info.plist` declares that scene.
 *
 * Every step is idempotent: `prebuild` without `--clean` runs mods over files
 * it has already modified.
 */

/** Result of {@link patchAppDelegate}. */
export interface AppDelegatePatch {
  readonly contents: string;
  /**
   * Set when the file is not a shape this patch recognises (a hand-edited or
   * future template). The contents are then returned unchanged: guessing at an
   * unknown `AppDelegate` is worse than saying so.
   */
  readonly warning?: string;
}

const MANUAL_FIX =
  'Apply the scene life cycle patch by hand: see "The app crashes at launch" in the ' +
  '@taaltreelabs/on-device-llm README.';

const CLASS_DECLARATION = /class AppDelegate: ExpoAppDelegate(\s*)\{/;

/**
 * `#if os(iOS) || os(tvOS)` … `window = UIWindow(…)` … `startReactNative(…)`
 * … `#endif` — the template's pre-scene start-up block.
 */
const START_BLOCK =
  /\n[ \t]*#if os\(iOS\) \|\| os\(tvOS\)\n[ \t]*window = UIWindow\([^\n]*\n[ \t]*factory\.startReactNative\([\s\S]*?\)\n[ \t]*#endif\n/;

const MODULE_NAME = /withModuleName:\s*"([^"]+)"/;

const FACTORY_PROPERTY = /(\n([ \t]*)var reactNativeFactory: RCTReactNativeFactory\?\n)/;

const SCENE_DELEGATE = /\bclass\s+SceneDelegate\b/;

/** Whether a Swift source file declares a class named `SceneDelegate`. */
export function declaresSceneDelegate(source: string): boolean {
  return SCENE_DELEGATE.test(source);
}

/** Options for {@link patchAppDelegate}. */
export interface PatchAppDelegateOptions {
  /**
   * Another Swift file in the app target already declares `SceneDelegate` (a
   * `SceneDelegate.swift` from a hand-applied patch).
   * Declaring a second one would not compile.
   */
  readonly sceneDelegateDeclaredElsewhere?: boolean;
}

/** Rewrite a Swift `AppDelegate.swift` for the scene-based life cycle. */
export function patchAppDelegate(
  contents: string,
  options: PatchAppDelegateOptions = {}
): AppDelegatePatch {
  let next = contents;
  const alreadyProvider = next.includes('ExpoReactNativeFactoryProvider');

  if (!alreadyProvider) {
    const start = START_BLOCK.exec(next);
    if (!CLASS_DECLARATION.test(next) || start === null || !FACTORY_PROPERTY.test(next)) {
      return {
        contents,
        warning:
          'AppDelegate.swift does not match the Expo template this plugin knows how to ' +
          `patch, so it was left unchanged. ${MANUAL_FIX}`,
      };
    }
    const moduleName = MODULE_NAME.exec(start[0])?.[1] ?? 'main';

    next = next.replace(
      CLASS_DECLARATION,
      'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider$1{'
    );
    next = next.replace(
      FACTORY_PROPERTY,
      `$1$2var reactNativeFactoryModuleName: String { ${JSON.stringify(moduleName)} }\n`
    );
    next = next.replace(
      START_BLOCK,
      '\n    // The iOS 27 SDK requires the scene-based life cycle: SceneDelegate\n' +
        '    // (ExpoAppSceneDelegate) creates the window and starts React Native with\n' +
        '    // the factory built above, so nothing is started here.\n'
    );
  } else if (/factory\.startReactNative\(/.test(next)) {
    // Adopts the provider but still starts React Native itself: somebody's
    // half-finished migration. Two starts would be worse than the crash.
    return {
      contents,
      warning:
        'AppDelegate.swift adopts ExpoReactNativeFactoryProvider but still calls ' +
        `startReactNative, so it was left unchanged. ${MANUAL_FIX}`,
    };
  }

  if (options.sceneDelegateDeclaredElsewhere !== true && !declaresSceneDelegate(next)) {
    next =
      next.replace(/\s*$/, '\n') +
      '\n// iOS 27 requires the scene-based life cycle; ExpoAppSceneDelegate creates the\n' +
      '// window and starts React Native from the connecting scene. Added by the\n' +
      '// @taaltreelabs/on-device-llm config plugin.\n' +
      'class SceneDelegate: ExpoAppSceneDelegate {}\n';
  }

  return { contents: next };
}

/** The `Info.plist` value that routes the app's one scene to `SceneDelegate`. */
export const SCENE_MANIFEST = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      {
        UISceneConfigurationName: 'Default Configuration',
        UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
      },
    ],
  },
} as const;

/**
 * Add the scene manifest to an `Info.plist`, unless it already declares one —
 * an app that has configured its own scenes knows better than this plugin.
 */
export function patchInfoPlist<T extends Record<string, unknown>>(plist: T): T {
  if (plist['UIApplicationSceneManifest'] !== undefined) return plist;
  return {
    ...plist,
    UIApplicationSceneManifest: structuredClone(SCENE_MANIFEST) as unknown,
  };
}
