/**
 * Expo config plugin for `@taaltreelabs/on-device-llm`, loaded through the
 * package root's `app.plugin.js` when an app lists the package in `plugins`:
 *
 *   { "expo": { "plugins": ["@taaltreelabs/on-device-llm"] } }
 *
 * It applies the iOS 27 scene life cycle patch during `prebuild` (see
 * `./scene-lifecycle.ts` and DECISIONS.md D41). Build-time only: it runs in
 * Node under the Expo CLI and is never part of an app bundle, which is why it
 * is not a subpath export.
 */

import {
  createRunOncePlugin,
  withAppDelegate,
  withInfoPlist,
  WarningAggregator,
  type ConfigPlugin,
} from 'expo/config-plugins';
import fs from 'fs';
import path from 'path';

import { declaresSceneDelegate, patchAppDelegate, patchInfoPlist } from './scene-lifecycle';

const PACKAGE_NAME = '@taaltreelabs/on-device-llm';

/** Whether a Swift file next to `AppDelegate.swift` already declares `SceneDelegate`. */
function otherSwiftFileDeclaresSceneDelegate(appDelegatePath: string): boolean {
  const directory = path.dirname(appDelegatePath);
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return false;
  }
  return entries.some((entry) => {
    const file = path.join(directory, entry);
    if (!entry.endsWith('.swift') || file === appDelegatePath) return false;
    try {
      return declaresSceneDelegate(fs.readFileSync(file, 'utf8'));
    } catch {
      return false;
    }
  });
}

const withSceneLifecycle: ConfigPlugin = (config) => {
  config = withAppDelegate(config, (appDelegate) => {
    if (appDelegate.modResults.language !== 'swift') {
      WarningAggregator.addWarningIOS(
        PACKAGE_NAME,
        'AppDelegate is not Swift, so the iOS 27 scene life cycle patch was not applied. ' +
          'See "The app crashes at launch" in the README.'
      );
      return appDelegate;
    }
    const patch = patchAppDelegate(appDelegate.modResults.contents, {
      sceneDelegateDeclaredElsewhere: otherSwiftFileDeclaresSceneDelegate(
        appDelegate.modResults.path
      ),
    });
    if (patch.warning !== undefined) WarningAggregator.addWarningIOS(PACKAGE_NAME, patch.warning);
    appDelegate.modResults.contents = patch.contents;
    return appDelegate;
  });

  return withInfoPlist(config, (infoPlist) => {
    infoPlist.modResults = patchInfoPlist(infoPlist.modResults);
    return infoPlist;
  });
};

export default createRunOncePlugin(withSceneLifecycle, PACKAGE_NAME);
