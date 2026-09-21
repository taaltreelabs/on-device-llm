const { defineConfig } = require('eslint/config');
const universe = require('eslint-config-universe/flat/native');
const universeWeb = require('eslint-config-universe/flat/web');

// The isolation rule (docs/plan.md §2, DECISIONS.md D1-D9): `src/core` and
// `src/openai` must be importable from plain Node with nothing
// React/React-Native/Expo/native anywhere in their import graph. This
// override forbids the forbidden specifiers via both ES import syntax
// (no-restricted-imports) and CommonJS require() (no-restricted-modules).
//
// The mechanical enforcement lives here (fails a `lint` you can see before
// you ship) and in `scripts/check-isolation.mjs` (fails against the built
// output, so it also catches transitive imports pulled in through a
// dependency of core/openai rather than a direct import from these files).
//
// To sanity-check this rule fires: temporarily add `import 'react';` (or
// `import x from '../apple';`) to src/core/index.ts and run
// `npm run lint` — it should report an isolation violation. Remove the
// line afterwards; do not commit it.
const isolationForbidden = [
  { name: 'react', message: 'src/core and src/openai must stay importable from plain Node (see docs/plan.md §2).' },
  { name: 'react-native', message: 'src/core and src/openai must stay importable from plain Node (see docs/plan.md §2).' },
];

const isolationForbiddenPatterns = [
  'react-native/*',
  'expo',
  'expo-*',
  'expo/*',
  '**/apple',
  '**/apple/*',
  '**/react',
  '**/react/*',
];

const isolationOverride = {
  files: ['src/core/**/*.{ts,tsx}', 'src/openai/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: isolationForbidden,
        patterns: [
          {
            group: isolationForbiddenPatterns,
            message:
              'src/core and src/openai must stay importable from plain Node with no React/React Native/Expo/native module in the graph (see docs/plan.md §2, DECISIONS.md).',
          },
        ],
      },
    ],
    'no-restricted-modules': [
      'error',
      {
        paths: isolationForbidden.map(({ name, message }) => ({ name, message })),
        patterns: isolationForbiddenPatterns,
      },
    ],
  },
};

module.exports = defineConfig([
  { ignores: ['build'] },
  ...universe,
  ...universeWeb,
  isolationOverride,
]);
