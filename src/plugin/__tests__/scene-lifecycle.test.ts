/**
 * The config plugin's source transforms (DECISIONS.md D41). The fixture is the
 * AppDelegate.swift a pristine `expo prebuild` of an Expo 57 app generates;
 * the example app's hand-patched one is the reference for the expected result.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  declaresSceneDelegate,
  patchAppDelegate,
  patchInfoPlist,
  SCENE_MANIFEST,
} from '../scene-lifecycle';

const template = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'expo-57-AppDelegate.swift'),
  'utf8'
);
const exampleAppDelegate = fs.readFileSync(
  path.join(__dirname, '../../../example/ios/ondevicellmexample/AppDelegate.swift'),
  'utf8'
);

/** Collapse comments and whitespace so two files compare by code alone. */
function code(source: string): string {
  return source
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('patchAppDelegate', () => {
  it('turns the Expo 57 template into the example app’s scene-based AppDelegate', () => {
    const patch = patchAppDelegate(template);
    expect(patch.warning).toBeUndefined();
    // Same code as the hand-patched example, plus the SceneDelegate that the
    // example keeps in its own file.
    expect(code(patch.contents)).toBe(
      code(exampleAppDelegate + '\nclass SceneDelegate: ExpoAppSceneDelegate {}\n')
    );
  });

  it('no longer creates a window or starts React Native itself', () => {
    const { contents } = patchAppDelegate(template);
    expect(contents).not.toMatch(/startReactNative/);
    expect(contents).not.toMatch(/UIWindow\(/);
    expect(contents).toMatch(
      /class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider \{/
    );
    expect(contents).toMatch(/var reactNativeFactoryModuleName: String \{ "main" \}/);
    expect(declaresSceneDelegate(contents)).toBe(true);
  });

  it('keeps a custom module name from the template', () => {
    const custom = template.replace('withModuleName: "main"', 'withModuleName: "MyApp"');
    expect(patchAppDelegate(custom).contents).toMatch(
      /var reactNativeFactoryModuleName: String \{ "MyApp" \}/
    );
  });

  it('is idempotent: prebuild without --clean runs it over its own output', () => {
    const once = patchAppDelegate(template).contents;
    const twice = patchAppDelegate(once);
    expect(twice.warning).toBeUndefined();
    expect(twice.contents).toBe(once);
  });

  it('adds no second SceneDelegate when another file already declares one', () => {
    // The example app: patched by hand, SceneDelegate in SceneDelegate.swift.
    const patch = patchAppDelegate(exampleAppDelegate, { sceneDelegateDeclaredElsewhere: true });
    expect(patch.warning).toBeUndefined();
    expect(patch.contents).toBe(exampleAppDelegate);
    // Same for a fresh template whose SceneDelegate lives elsewhere.
    expect(
      declaresSceneDelegate(
        patchAppDelegate(template, { sceneDelegateDeclaredElsewhere: true }).contents
      )
    ).toBe(false);
  });

  it('leaves an AppDelegate it does not recognise unchanged, with a warning', () => {
    const custom = template.replace(/#if os\(iOS\)[\s\S]*?#endif\n/, '    startMyOwnWay()\n');
    const patch = patchAppDelegate(custom);
    expect(patch.contents).toBe(custom);
    expect(patch.warning).toMatch(/does not match the Expo template/);
  });

  it('refuses a half-finished migration rather than starting React Native twice', () => {
    const half = template.replace(
      'class AppDelegate: ExpoAppDelegate {',
      'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {'
    );
    const patch = patchAppDelegate(half);
    expect(patch.contents).toBe(half);
    expect(patch.warning).toMatch(/still calls startReactNative/);
  });
});

describe('patchInfoPlist', () => {
  it('declares the one scene, routed to SceneDelegate', () => {
    const plist = patchInfoPlist({ CFBundleName: 'app' });
    expect(plist).toEqual({ CFBundleName: 'app', UIApplicationSceneManifest: SCENE_MANIFEST });
  });

  it('leaves an app’s own scene configuration alone', () => {
    const own = { UIApplicationSceneManifest: { UIApplicationSupportsMultipleScenes: true } };
    expect(patchInfoPlist(own)).toBe(own);
  });
});
