# Note to Tasks

A standalone Expo app that turns a short note into an editable checklist using
Apple Foundation Models. It installs `@taaltreelabs/on-device-llm@1.0.1` from npm;
there are no source aliases or links to the parent repository.

**On-device extraction only. No backend, API key, or cloud fallback.**

## Run it

You need Node.js 22.13+, macOS with **Xcode 27+ and the iOS 27 SDK**, and an
Apple Intelligence-compatible iPhone running iOS 26+. Enable Apple Intelligence
and let its model assets download first. Expo Go cannot load the native module.
The build-time SDK requirement is higher than the runtime OS requirement.

```bash
git clone https://github.com/taaltreelabs/on-device-llm.git
cd on-device-llm/starters/task-extractor
npm ci
npm run ios
```

Select your connected iPhone when prompted. Set up signing in Xcode if needed;
change `expo.ios.bundleIdentifier` in `app.json` to a unique identifier for your
team before creating a signed build. Rebuild after changing native configuration.

You can also copy just this directory into your own project folder. No root
repository install or build is required. It uses Expo SDK 57, React Native 0.86.3,
React 19.2.3, and the published SDK pinned in `package.json` and `package-lock.json`.

## Try the feature

1. Wait for “Apple Intelligence is ready.”
2. Tap **Extract tasks** to process the sample note, or write your own short note.
3. Review the generated titles and timing. Both are editable.
4. Check off tasks or tap **Share checklist** to open the system share sheet.

For the sample, look for booking tickets tonight, asking Sam to water the plants,
and packing the charger on Friday. The already-booked hotel should be omitted.
Exact output varies; a schema controls structure, not factual accuracy.

Notes and tasks are held only in memory. Changing the note clears its old results;
restarting the app clears your work. The app does not save tasks to Reminders or
create calendar events. Sharing is an explicit action that passes your checklist
to the app you select.

## How it works

- `task.ts`: supported JSON Schema, bounded input, extraction instructions, and
  runtime validation of the returned object.
- `App.tsx`: availability and capability checks, extraction with `useGenerate`,
  cancellation, editable task cards, completion toggles, and sharing.
- `app.json`: the package's Expo config plugin for native setup.

Read the [full tutorial](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/tutorials/expo-task-extractor.md) to adapt it.

## Checks

```bash
npm run typecheck
npm test
```

These checks cover TypeScript, schema compatibility with the installed SDK, input
bounds, and malformed output handling. They do not exercise Apple's live model.

Before sharing your own build, check on a physical device:

- Sample note → relevant tasks; completed hotel booking omitted.
- A note with no actions → a clear empty state.
- Blank note → extraction disabled.
- Stop during generation → cancellation feedback and no stale checklist.
- Edit the note after generation → old checklist disappears.
- Apple Intelligence disabled → setup guidance, then a refresh on returning from Settings.
- Edit/check/share → the shared text reflects your changes.
- With model assets already downloaded and a bundled build installed, disable
  networking and repeat extraction. A development build using Metro still needs
  its JavaScript bundle; use a signed Release build for a fully offline demo.

For a bundled device build:

```bash
npx expo run:ios --device --configuration Release
```

Model availability does not guarantee generation will succeed. Errors remain
visible in the app. If generation exceeds context, shorten the note; the 1,500
character limit is a UI budget, not an exact token limit.

See [troubleshooting](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/troubleshooting.md) for native build or model
issues. Android, web, and unsupported Apple devices cannot run extraction in this
starter; there is no simulated success or automatic cloud upload.

## A 30-second demo to record

Open the installed app with the sample note. Show the on-device label, tap
**Extract tasks**, then show the resulting checklist. Edit one title, check off a
task, and open **Share checklist**. Keep the real generation time visible; do not
present a sped-up recording as a latency benchmark. Review the generated content
before recording. No pre-recorded model output is bundled with this starter.

## License

[MIT](LICENSE).
