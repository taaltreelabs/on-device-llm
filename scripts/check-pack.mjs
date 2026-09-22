#!/usr/bin/env node
/**
 * Verifies the published npm tarball (docs/plan.md §5 Phase 5) contains
 * exactly what consumers need and nothing else:
 *
 *   present  — compiled JS + type declarations for every subpath export,
 *              the ios/ sources + podspec, the android/ stub module,
 *              expo-module.config.json, README.md, LICENSE.
 *   absent   — the example app, the SwiftPM harness, docs/, src/, scripts/,
 *              .github/, and any test file.
 *
 * Runs `npm pack --json --dry-run`, which builds the real file list npm
 * would tar up (package.json "files" + npm's built-in always-included/
 * always-ignored rules + .npmignore), and asserts against that list. It
 * does not build the tarball or touch the filesystem.
 *
 * Plain Node, zero dependencies, matching the rest of scripts/.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const failures = [];

function fail(message) {
  failures.push(message);
}

function run() {
  const raw = execFileSync('npm', ['pack', '--json', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32,
  });
  // `npm pack` can print non-JSON npm-lifecycle noise before the JSON
  // array on some npm versions/configs; the JSON payload is the last
  // top-level `[...]` in stdout.
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    console.error(
      'check:pack FAILED\n\n  - could not find JSON output in `npm pack --json --dry-run`:\n'
    );
    console.error(raw);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    console.error(
      'check:pack FAILED\n\n  - could not parse `npm pack --json --dry-run` output as JSON:\n'
    );
    console.error(raw);
    console.error(err);
    process.exit(1);
  }
  return parsed[0];
}

const pack = run();
const files = pack.files.map((f) => f.path);
const fileSet = new Set(files);

// ---- name / version -------------------------------------------------

if (!pack.name || typeof pack.name !== 'string') {
  fail('package name is missing from `npm pack` output');
}
if (!pack.version || typeof pack.version !== 'string') {
  fail('package version is missing from `npm pack` output');
}

// ---- present: build/ compiled JS + d.ts for every subpath -----------

const SUBPATHS = ['', 'core', 'openai', 'apple', 'react'];
for (const sub of SUBPATHS) {
  const base = sub ? `build/${sub}/index` : 'build/index';
  for (const ext of ['.js', '.d.ts']) {
    const p = `${base}${ext}`;
    if (!fileSet.has(p)) {
      fail(`missing required file: ${p} (compiled output for the "${sub || '.'}" subpath export)`);
    }
  }
}

// ---- present: ios/ sources + podspec ---------------------------------

const swiftFiles = files.filter((f) => f.startsWith('ios/') && f.endsWith('.swift'));
if (swiftFiles.length === 0) {
  fail('missing required files: no ios/*.swift files found in the tarball');
}
if (!fileSet.has('ios/OnDeviceLlm.podspec')) {
  fail('missing required file: ios/OnDeviceLlm.podspec');
}
const iosCoreSwiftFiles = files.filter((f) => f.startsWith('ios/Core/') && f.endsWith('.swift'));
if (iosCoreSwiftFiles.length === 0) {
  fail('missing required files: no ios/Core/*.swift files found in the tarball');
}

// ---- present: expo-module.config.json ---------------------------------

if (!fileSet.has('expo-module.config.json')) {
  fail('missing required file: expo-module.config.json');
}

// ---- present: android/ stub module ------------------------------------

const androidFiles = files.filter((f) => f.startsWith('android/'));
if (androidFiles.length === 0) {
  fail(
    'missing required files: no android/ files found in the tarball (expected the stub Expo module)'
  );
}

// ---- present: README.md + LICENSE --------------------------------------

for (const p of ['README.md', 'LICENSE']) {
  if (!fileSet.has(p)) {
    fail(`missing required file: ${p}`);
  }
}

// ---- absent: example/, harness/, docs/, src/, scripts/, .github/ -------

const FORBIDDEN_PREFIXES = ['example/', 'harness/', 'docs/', 'src/', 'scripts/', '.github/'];
for (const f of files) {
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (f === prefix.slice(0, -1) || f.startsWith(prefix)) {
      fail(`forbidden path present: ${f} (matches disallowed prefix "${prefix}")`);
    }
  }
}

// ---- absent: any test file ---------------------------------------------

for (const f of files) {
  const base = path.basename(f);
  const isTestFile = /\.test\.[^.]+$/.test(base) || f.split('/').includes('__tests__');
  if (isTestFile) {
    fail(`forbidden test file present: ${f}`);
  }
}

// ---- absent: stray native build artifacts ------------------------------
//
// Defensive guard, not required by docs/plan.md §5, but a real regression
// this script caught during Phase 5 work: a local `android/build/` Gradle
// output directory (generated by running Gradle against the stub module
// directly, gitignored, untracked) was being swept into the tarball
// wholesale by the `files: ["android"]` package.json entry. Removed once;
// this assertion keeps it from silently reappearing.

for (const f of files) {
  const segments = f.split('/');
  if (segments.length > 1 && segments[1] === 'build' && segments[0] !== 'build') {
    fail(
      `forbidden generated-build path present: ${f} (looks like stray native build output under "${segments[0]}/build/")`
    );
  }
}

// ---- report --------------------------------------------------------------

if (failures.length > 0) {
  console.error(`check:pack FAILED against ${pack.name}@${pack.version} (${files.length} files)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`\n${failures.length} pack violation(s) found.`);
  process.exit(1);
}

console.log(
  `check:pack OK — ${pack.name}@${pack.version}: ${files.length} files, all required paths present, no forbidden paths.`
);
