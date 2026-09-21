#!/usr/bin/env node
/**
 * Enforces the isolation rule from docs/plan.md §2 / DECISIONS.md D1-D9:
 * `core` and `openai` must be importable from plain Node with nothing
 * React, React Native, Expo, or native anywhere in their import graph.
 *
 * This runs against the *built* output (npm run build first), not the
 * TypeScript source, so it also catches anything the ESLint isolation
 * rule (eslint.config.cjs) can't see — e.g. a forbidden import
 * re-introduced by a refactor that ESLint wasn't run against, or one that
 * arrives transitively through a same-package relative import chain.
 *
 * Two checks, both must pass:
 *   1. Functional: dynamically import the built `core` and `openai` entry
 *      points and confirm they load without throwing.
 *   2. Structural: statically walk the require()/import graph reachable
 *      from those entry points and fail if any forbidden specifier
 *      appears anywhere in it.
 *
 * Plain Node, zero dependencies, by design (matches the package it's
 * checking).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build');

const ENTRY_POINTS = ['core', 'openai'];

// Bare specifiers (or prefixes of them) that must never appear in the
// core/openai graph.
const FORBIDDEN_BARE = /^(react|react-native)(\/.*)?$|^expo(-[^/]*)?(\/.*)?$/;

const failures = [];

function isForbiddenBareSpecifier(specifier) {
  return FORBIDDEN_BARE.test(specifier);
}

/** Extract string specifiers passed to require(...), import(...), or `from '...'`. */
function extractSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s+['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** Resolve a relative require/import specifier to an on-disk .js file, CJS-style. */
function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function walk(entry) {
  const entryFile = path.join(buildDir, entry, 'index.js');
  if (!existsSync(entryFile)) {
    failures.push(
      `[${entry}] build output missing: ${path.relative(root, entryFile)} (did you run "npm run build"?)`
    );
    return;
  }

  const visited = new Set();
  const queue = [entryFile];

  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(file, 'utf8');
    for (const specifier of extractSpecifiers(source)) {
      if (isForbiddenBareSpecifier(specifier)) {
        failures.push(
          `[${entry}] ${path.relative(root, file)} imports forbidden specifier "${specifier}"`
        );
        continue;
      }

      if (!specifier.startsWith('.')) {
        // Bare specifier that isn't forbidden (there shouldn't be any,
        // since core/openai ship zero runtime dependencies, but this
        // isn't this script's job to enforce package.json contents).
        continue;
      }

      const resolved = resolveRelative(file, specifier);
      if (!resolved) {
        failures.push(
          `[${entry}] ${path.relative(root, file)} imports "${specifier}", which does not resolve under build/ — cannot verify isolation`
        );
        continue;
      }

      const relFromBuild = path.relative(buildDir, resolved);
      const topLevelDir = relFromBuild.split(path.sep)[0];
      if (topLevelDir === 'apple' || topLevelDir === 'react') {
        failures.push(
          `[${entry}] ${path.relative(root, file)} reaches into "${topLevelDir}/" via "${specifier}" — forbidden by the isolation rule`
        );
        // Still worth walking further in case it also directly imports
        // something forbidden.
      }

      queue.push(resolved);
    }
  }
}

async function checkImportable(entry) {
  const entryFile = path.join(buildDir, entry, 'index.js');
  if (!existsSync(entryFile)) return; // already reported by walk()
  try {
    await import(pathToFileURL(entryFile).href);
  } catch (err) {
    failures.push(
      `[${entry}] importing ${path.relative(root, entryFile)} from plain Node threw: ${err?.stack ?? err}`
    );
  }
}

for (const entry of ENTRY_POINTS) {
  walk(entry);
}

for (const entry of ENTRY_POINTS) {
  await checkImportable(entry);
}

if (failures.length > 0) {
  console.error('check:isolation FAILED\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`\n${failures.length} isolation violation(s) found.`);
  process.exit(1);
}

console.log(
  `check:isolation OK — ${ENTRY_POINTS.join(', ')} import cleanly from plain Node with no forbidden specifiers in their graph.`
);
