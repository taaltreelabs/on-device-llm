# Build an offline task extractor with Expo and Apple Foundation Models

Turn this note:

> Before the trip: book the train tickets tonight, ask Sam to water the plants,
> and pack the charger on Friday. The hotel is already booked.

into an editable checklist inside a React Native app. We'll ask Apple's on-device
model for structured data, then let the user review, edit, complete, and share
the tasks. No backend or API key is needed for extraction.

This tutorial uses `@taaltreelabs/on-device-llm`, an MIT-licensed package maintained
by TaalTree Labs. The [complete Expo starter](../../starters/task-extractor)
installs the published npm package rather than importing library source.

## What you need

- Node.js 22.13 or later and a Mac with **Xcode 27+ / iOS 27 SDK** to compile this package.
- An Apple Intelligence-compatible physical iPhone running **iOS 26+**, with
  Apple Intelligence enabled and model assets downloaded.
- An iOS development build. **Expo Go cannot load this native module.**

The starter pins `@taaltreelabs/on-device-llm` to **1.0.1** and uses Expo **57**,
React Native **0.86.3**, and React **19.2.3**. See the
[Expo 57 reference](https://docs.expo.dev/versions/v57.0.0/) for Expo's requirements;
this package additionally requires the newer Xcode SDK mentioned above.

“Offline” describes the model's inference path once assets and the app are
installed. Installing dependencies and model assets needs network access. A
development session also needs Metro to serve its JavaScript; a bundled Release
build removes that dependency.

## 1. Run the complete starter

```bash
git clone https://github.com/taaltreelabs/on-device-llm.git
cd on-device-llm/starters/task-extractor
npm ci
npm run ios
```

Select your connected iPhone. If signing requires it, set a unique
`expo.ios.bundleIdentifier` in `app.json` and configure your team in Xcode. You can
copy the starter directory elsewhere; it has no dependency on the parent checkout.

When the screen says Apple Intelligence is ready, tap **Extract tasks**. You should
get actions for the tickets, plants, and charger, with the hotel booking omitted.
The phrasing may vary. Edit a task and use **Share checklist** to pass it to another
app. Nothing is saved to Reminders automatically.

If you're adding the feature to an existing Expo app instead, install:

```bash
npm install @taaltreelabs/on-device-llm@1.0.1
npx expo install react-native-safe-area-context
```

Add `"@taaltreelabs/on-device-llm"` to the `expo.plugins` array in your `app.json`.
Copy `task.ts` and the screen from the starter. In an Expo Router app, put the screen
in a route and keep `task.ts` outside the routes directory, adjusting its import.
Rebuild with `npx expo run:ios --device`; a JavaScript reload cannot add native modules.

## 2. Describe the data you want

The UI needs task titles and optional timing, not a paragraph that it must parse.
In [`task.ts`](../../starters/task-extractor/task.ts), a JSON Schema defines that
shape. Here is the same essential structure:

```ts
import type { JsonSchema } from '@taaltreelabs/on-device-llm/core';

const schema: JsonSchema = {
  type: 'object',
  title: 'TaskList',
  properties: {
    tasks: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        title: 'Task',
        properties: {
          title: { type: 'string' },
          when: { type: 'string' },
        },
        required: ['title', 'when'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
};
```

Use an empty `when` string when the note has no timing. Preserve phrases such as
“tonight” rather than guessing dates or time zones. This also avoids nullable
unions and date-format constraints, which are outside this provider's
[supported schema subset](../structured-output.md#the-supported-subset).

The starter adds descriptions to guide the model. It asks for at most eight
unfinished actions, excludes completed work, and returns an empty list when there
is nothing to do. The 1,500-character input limit keeps the demo focused on short
notes; it does not guarantee that every language or request fits the context window.

## 3. Generate a structured result

Create the provider outside the component so its identity is stable:

```ts
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';

const apple = createAppleProvider();
```

Inside your component, `useGenerate(apple)` supplies `generate`, `loading`, and
`abort`. The starter's extraction handler follows this pattern:

```tsx
const { generate, loading, abort } = useGenerate(apple);

async function extract() {
  try {
    const result = await generate(extractionRequest(note));
    const tasks = parseTasks(result.object);
    // Store these tasks in screen state for review and editing.
  } catch (error) {
    // Show a helpful error or cancellation message in the screen.
  }
}
```

This is an excerpt from the screen, not a second standalone app. Import
`useGenerate` from `@taaltreelabs/on-device-llm/react`, and `extractionRequest` and
`parseTasks` from the starter's `task.ts`. See [`App.tsx`](../../starters/task-extractor/App.tsx)
for the complete state handling, rendering, and imports.

`extractionRequest(note)` places extraction instructions in a system message,
puts the note in a user message, and attaches the schema. Keeping instructions
separate from the note clarifies the task; it does not make a model immune to
misleading input.

`result.object` is typed as `unknown`. `parseTasks` checks the array and required
fields before the app renders them. Guided generation controls shape; it cannot
guarantee that every extracted task is correct. That's why the checklist is editable
and nothing is executed automatically.

Use `useGenerate` for this single structured request. `useChat` is intended for a
text conversation and does not accept a schema. Also, `generate` rejects on failure
even though the hook exposes error state: catch that promise in your event handler.

## 4. Handle a device that isn't ready

The starter calls `useAvailability(apple)` and requires both
`availability.available` and `capabilities.structuredOutput` before enabling
extraction. It explains missing model assets, disabled Apple Intelligence, or
unsupported devices, and checks again when the app returns to the foreground.

Availability is a preflight check, not a promise of successful generation. Keep
request errors visible, allow retry, and call `abort()` when the user taps Stop.
The starter clears previous results before a request and when the note changes,
so a failed request cannot appear to have produced an old checklist.

## 5. Make the result useful

The starter renders each task with editable title and timing fields plus a
completion checkbox. Its share button uses React Native's system share sheet.
That gives users a useful next action without calendar permissions or a database.

The screen explicitly says **On-device only · No cloud fallback**. That is accurate
because it uses the Apple provider directly. It keeps notes and tasks in memory;
restarting the app clears them. Sharing intentionally sends the checklist to the
app the user chooses.

If you later add the package's [cloud router](../../README.md#add-cloud-fallback-when-you-need-it),
update the UI and data-handling explanation too. The note may then leave the device.
Use `result.providerId` to report which provider answered; do not keep labeling all
results as generated locally.

## 6. Verify before you share

```bash
npm run typecheck
npm test
```

These checks validate the screen's TypeScript, the schema against the installed
SDK, and the input/output guards. They do not substitute for a physical-device run.
Use the [starter's device checklist](../../starters/task-extractor/README.md#checks)
to check successful extraction, no-action notes, cancellation, unavailability,
editing, and sharing. Treat the example output as an expectation to evaluate,
not a recorded benchmark or a guarantee of model accuracy.

For an offline demonstration, first install a signed build with a bundled JS asset:

```bash
npx expo run:ios --device --configuration Release
```

With the model assets already installed, disable networking and try extraction.
Record the real interaction rather than replacing generation with hardcoded results.

## Where to take it next

Adapt the schema for shopping lists, packing checklists, or action items from short
meeting notes. Start with a small, reviewable result and collect feedback on whether
it saves users time. Add storage or explicit user-approved actions only when the
feature needs them.

[Get the starter](../../starters/task-extractor) ·
[Package quick start](../../README.md#quick-start) ·
[Report an issue](https://github.com/taaltreelabs/on-device-llm/issues)
