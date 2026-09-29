<p align="center">
  <a href="https://taaltreelabs.com">
    <img src="docs/assets/taaltree-labs.svg" alt="TaalTree Labs" width="88" height="88">
  </a>
</p>

# @taaltreelabs/on-device-llm

Add on-device AI to your Expo app—with React hooks, conversation management, and configurable cloud fallback.

Start with Apple's Foundation Models on a supported iPhone. No backend or API key
is needed for on-device generation. Add your own Chat Completions-compatible
endpoint when you want cloud fallback.

[Documentation](https://taaltreelabs.com/docs/on-device-llm/) ·
[Task-extraction starter](https://github.com/taaltreelabs/on-device-llm/tree/main/starters/task-extractor) ·
[Report an issue](https://github.com/taaltreelabs/on-device-llm/issues)

**Try a useful feature:** [turn a messy note into an editable checklist](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/tutorials/expo-task-extractor.md).
The standalone Expo starter installs this package from npm and runs extraction
on-device, with no cloud fallback.

## Features

- **On-device generation:** use Apple's model on supported devices, including streaming, structured output, and tool calling.
- **Configurable fallback:** choose when to try another provider if the device model is unavailable or a request fails.
- **Conversation management:** fit chat history into the model's context window with trimming or rolling summaries.
- **React hooks:** build UI with `useChat`, `useGenerate`, and `useAvailability`.
- **Reusable core:** use routing, context management, and the cloud provider in Node.js and browsers, with no runtime dependencies.

## Requirements

| To use…                    | You need…                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Apple's on-device model    | iOS / macOS 26+, Apple Intelligence-eligible hardware, Apple Intelligence enabled, and downloaded model assets |
| The Expo quick start below | macOS with Xcode 27+ (iOS 27 SDK), and an iOS development build; Expo Go cannot load the native module         |
| Cloud generation           | A Chat Completions-compatible endpoint and a model available on that endpoint                                  |
| React hooks                | React                                                                                                          |

The [example app](example)
uses **Expo SDK 57 and React Native 0.86.3**. See the
[compatibility guide](docs/compatibility.md)
for repository versions, native build requirements, and feature support.

On older iOS versions and on Android, web, or Node.js, the Apple provider reports
`unsupportedPlatform`; a router can use your configured cloud provider instead.
On-device Android generation is available in the separate, pre-release
[`@taaltreelabs/on-device-llm-android`](https://github.com/taaltreelabs/on-device-llm-android)
package. Check its device requirements and data-handling terms before using it.

## Quick start

### 1. Install and configure

In an existing Expo app:

```bash
npm install @taaltreelabs/on-device-llm
```

Add the package to your existing `plugins` list in `app.json`:

```json
{
  "expo": {
    "plugins": ["@taaltreelabs/on-device-llm"]
  }
}
```

The plugin applies the scene lifecycle setup needed by the Expo 57 template when
building with the iOS 27 SDK. If you have customized your native app, check the
[setup troubleshooting guide](docs/troubleshooting.md#the-app-crashes-at-launch-with-uiscene-life-cycle-is-required).

### 2. Run your first prompt on-device

For an Expo app with an `App.tsx` entry point, replace that file with the following.
In an Expo Router app, put it in a route file such as `app/index.tsx` instead.

```tsx
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import { useGenerate } from '@taaltreelabs/on-device-llm/react';
import { Button, Text, View } from 'react-native';

const apple = createAppleProvider();

export default function FirstPrompt() {
  const { generate, result, loading, error, abort } = useGenerate(apple);

  async function ask() {
    try {
      await generate({
        messages: [{ role: 'user', content: 'Suggest three things to pack for a train trip.' }],
      });
    } catch {
      // useGenerate exposes the failure through `error` below.
    }
  }

  return (
    <View style={{ padding: 24, paddingTop: 64, gap: 16 }}>
      <Text>On-device only · No cloud fallback</Text>
      <Button
        title={loading ? 'Thinking…' : 'Try on-device AI'}
        disabled={loading}
        onPress={() => void ask()}
      />
      {loading && <Button title="Stop" onPress={abort} />}
      {error && <Text accessibilityRole="alert">{error.message}</Text>}
      {!loading && !error && result && <Text>{result.text}</Text>}
    </View>
  );
}
```

This uses only the Apple provider. If the device model is unavailable, the request
fails and the error is displayed; nothing is sent to a cloud endpoint.
The [task-extraction starter](https://github.com/taaltreelabs/on-device-llm/tree/main/starters/task-extractor)
adds availability checks, structured output, and an editable checklist.

### 3. Build and run on your iPhone

```bash
npx expo run:ios --device
```

Select an Apple Intelligence-compatible physical device with iOS 26+, Apple
Intelligence enabled, and its model assets downloaded. Building this package
requires **Xcode 27+**, even when deploying to iOS 26. Follow Xcode's signing
setup if prompted. Expo Go cannot run this native module.

Rebuild after native configuration changes; a JavaScript reload cannot apply them.
If you already manage an `ios/` directory, follow the
[native setup troubleshooting](docs/troubleshooting.md) to apply plugin changes.

**Next:** [build the note-to-tasks app](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/tutorials/expo-task-extractor.md),
or use [`useChat`](docs/context.md) for a streaming conversation with managed history.

## Add cloud fallback when you need it

After the on-device example works, replace its `apple` provider with a router and
pass `llm` to `useGenerate(llm)` (or `useChat({ provider: llm })`):

```ts
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import { createRouter } from '@taaltreelabs/on-device-llm/core';
import { createOpenAIProvider } from '@taaltreelabs/on-device-llm/openai';
import { fetch as expoFetch } from 'expo/fetch';

const llm = createRouter({
  providers: [
    createAppleProvider(),
    createOpenAIProvider({
      baseUrl: 'https://your-backend.example.com/v1',
      model: 'your-model',
      fetch: expoFetch as unknown as typeof fetch,
      contextWindow: 128_000, // Set this to your model's context limit.
    }),
  ],
});
```

Replace `baseUrl` and `model` with your endpoint's values. Include any API prefix
such as `/v1`; the provider appends `/chat/completions`. Keep vendor API secrets
on your backend and add your app's authentication as needed. `EXPO_PUBLIC_*`
values are part of the client bundle, not secret storage.

Update the example's “On-device only” label if you enable fallback, and show
`result.providerId` to identify which provider actually answered. This changes
where content can go: explain the cloud path to your users. Injecting `expo/fetch`
also enables cloud streaming when using `useChat`; see the
[streaming guide](docs/streaming.md).

## Cloud fallback and privacy

With the optional router above, providers are tried in preference order. By default,
fallback is enabled for unavailability, context overflow, network errors, rate
limits, unsupported languages, and errors marked transient. Guardrail fallback is
off; cancellation and invalid requests never trigger fallback.

**Fallback can send the request's conversation content to your configured endpoint.**
Choose providers and routing rules that match your app's data-handling requirements.
The `openai` provider is compatible with the Chat Completions API; it does not require
or automatically select OpenAI's servers.

| Component        | Where content goes                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Apple provider   | Inference runs on the device through Apple's FoundationModels framework                                                |
| Cloud provider   | Requests go to the `baseUrl` you configure                                                                             |
| Router and hooks | Dispatch requests to your providers; the package does not add prompt or response logging or separate content telemetry |

There is **no mid-stream fallback** after the router delivers its first event.
The `onRoute` callback reports routing metadata without prompt or response content.
See [routing policies and fallback](docs/routing.md)
for controls and examples.

## Documentation

| I want to…                                           | Guide                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Build an on-device note-to-tasks app                 | [Tutorial](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/tutorials/expo-task-extractor.md) |
| Check supported platforms, features, or availability | [Compatibility](docs/compatibility.md)                                                                    |
| Choose imports or use the package in Node.js         | [Import paths](docs/imports.md)                                                                           |
| Manage long chats or include current app state       | [Context management](docs/context.md)                                                                     |
| Control provider selection and fallback              | [Routing](docs/routing.md)                                                                                |
| Generate structured data                             | [Structured output](docs/structured-output.md)                                                            |
| Let the model call app functions                     | [Tool calling](docs/tools.md)                                                                             |
| Stream cloud responses in React Native               | [Streaming](docs/streaming.md)                                                                            |
| Add another provider or use a test double            | [Custom providers](docs/custom-providers.md)                                                              |
| Fix setup or runtime problems                        | [Troubleshooting](docs/troubleshooting.md)                                                                |

Tool calling is currently supported by the Apple provider, not the cloud provider.
Structured output support depends on the provider and schema; see the guides for
supported constraints.

This package supplies model access and conversation utilities. It does not include
UI components, embeddings, speech, image generation, or retrieval. The example app
shows integration patterns and provides a manual test environment.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)
for local setup, repository layout, and checks.

## License

[MIT](LICENSE) · Built by [TaalTree Labs](https://taaltreelabs.com).
