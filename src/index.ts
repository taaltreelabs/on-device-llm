/**
 * `@taaltreelabs/on-device-llm`
 *
 * Root entry point: everything, re-exported for RN/Expo apps. May import
 * React Native, Expo, and the native module (via `./apple`).
 *
 * See docs/plan.md §2 for the subpath export table and the isolation
 * rule that keeps `./core` and `./openai` free of React/RN/Expo.
 */

export * from './core';
export * from './openai';
export * from './apple';
export * from './react';
