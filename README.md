<p align="center">
  <a href="https://taaltreelabs.com">
    <img src="https://raw.githubusercontent.com/taaltreelabs/on-device-llm/main/docs/assets/taaltree-labs.svg" alt="TaalTree Labs" width="88" height="88">
  </a>
</p>

# @taaltreelabs/on-device-llm

On-device AI for React Native and Expo, with configurable cloud fallback and conversation context management.

Run prompts with Apple's Foundation Models, connect your own Chat Completions-compatible
endpoint, and use the same interface for both.

[Documentation](https://taaltreelabs.com/docs/on-device-llm/) ·
[Example app](https://github.com/taaltreelabs/on-device-llm/tree/main/example) ·
[Report an issue](https://github.com/taaltreelabs/on-device-llm/issues)

**Early release:** the API may change before 1.0.

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
| The Expo quick start below | An iOS development build; Expo Go cannot load the native module                                                |
| Cloud generation           | A Chat Completions-compatible endpoint and a model available on that endpoint                                  |
| React hooks                | React                                                                                                          |

The [example app](https://github.com/taaltreelabs/on-device-llm/tree/main/example)
uses **Expo SDK 57 and React Native 0.86.3**. See the
[compatibility guide](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/compatibility.md)
for repository versions, native build requirements, and feature support.

On older iOS versions and on Android, web, or Node.js, the Apple provider reports
`unsupportedPlatform`; a router can use your configured cloud provider instead.
On-device Android generation is available in the separate, pre-release
[`@taaltreelabs/on-device-llm-android`](https://github.com/taaltreelabs/on-device-llm-android)
package. Check its device requirements and data-handling terms before using it.

**iOS 26 validation:** compatibility and cloud fallback have been exercised in
Simulators; successful on-device generation on a physical iOS 26 device remains
unverified. See the [verification notes](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/research/ios26-compat.md).

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
[setup troubleshooting guide](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/troubleshooting.md#the-app-crashes-at-launch-with-uiscene-life-cycle-is-required).

### 2. Add a chat component

This example tries Apple first, then your backend endpoint. Replace `baseUrl` and
`model` with your endpoint's values; `baseUrl` must include any API prefix such as
`/v1`. The provider appends `/chat/completions`.

Keep vendor API secrets on your backend. Add your app's authentication to the
endpoint as needed; an `EXPO_PUBLIC_*` variable is part of the client bundle, not
secret storage.

```tsx
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import { createRouter } from '@taaltreelabs/on-device-llm/core';
import { createOpenAIProvider } from '@taaltreelabs/on-device-llm/openai';
import { useChat } from '@taaltreelabs/on-device-llm/react';
import { fetch as expoFetch } from 'expo/fetch';
import { Button, Text, View } from 'react-native';

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

export function Assistant() {
  const { messages, streamingText, status, error, send, stop } = useChat({
    provider: llm,
    systemPrompt: 'You are a concise assistant.',
  });

  return (
    <View>
      {messages.map((message, index) => (
        <Text key={index}>{message.content}</Text>
      ))}
      {streamingText !== undefined && <Text>{streamingText}</Text>}
      {error && <Text accessibilityRole="alert">{error.message}</Text>}
      <Button
        title="Ask"
        disabled={status !== 'idle'}
        onPress={() => void send('What should I cook tonight?')}
      />
      {status !== 'idle' && <Button title="Stop" onPress={stop} />}
    </View>
  );
}
```

`useChat` manages history, fits it to the context budget, and exposes streamed text
and errors. Passing `expo/fetch` enables cloud streaming in Expo; without a streaming
`fetch`, cloud responses arrive as one final text delta. Apple streaming uses the
native bridge. See the [streaming guide](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/streaming.md)
for other React Native setups.

For an **on-device-only** app, pass `createAppleProvider()` directly as the hook's
`provider` and omit the router and cloud provider. Requests then fail if the device
model cannot serve them; they are not sent to a cloud endpoint.

### 3. Build and run

```bash
npx expo run:ios
```

Use a supported physical device to try on-device generation. Rebuild after native
configuration changes; a JavaScript reload cannot apply them. If you already manage
an `ios/` directory, follow the [native setup troubleshooting](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/troubleshooting.md)
to apply the plugin changes to your build.

## Cloud fallback and privacy

With the quick-start router, providers are tried in preference order. By default,
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
See [routing policies and fallback](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/routing.md)
for controls and examples.

## Documentation

| I want to…                                           | Guide                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Check supported platforms, features, or availability | [Compatibility](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/compatibility.md)         |
| Choose imports or use the package in Node.js         | [Import paths](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/imports.md)                |
| Manage long chats or include current app state       | [Context management](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/context.md)          |
| Control provider selection and fallback              | [Routing](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/routing.md)                     |
| Generate structured data                             | [Structured output](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/structured-output.md) |
| Let the model call app functions                     | [Tool calling](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/tools.md)                  |
| Stream cloud responses in React Native               | [Streaming](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/streaming.md)                 |
| Add another provider or use a test double            | [Custom providers](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/custom-providers.md)   |
| Fix setup or runtime problems                        | [Troubleshooting](https://github.com/taaltreelabs/on-device-llm/blob/main/docs/troubleshooting.md)     |

Tool calling is currently supported by the Apple provider, not the cloud provider.
Structured output support depends on the provider and schema; see the guides for
supported constraints.

This package supplies model access and conversation utilities. It does not include
UI components, embeddings, speech, image generation, or retrieval. The example app
shows integration patterns and provides a manual test environment.

## Contributing

See [CONTRIBUTING.md](https://github.com/taaltreelabs/on-device-llm/blob/main/CONTRIBUTING.md)
for local setup, repository layout, and checks. For implementation background, see
[design decisions](https://github.com/taaltreelabs/on-device-llm/blob/main/DECISIONS.md).

## License

[MIT](https://github.com/taaltreelabs/on-device-llm/blob/main/LICENSE) · Built by [TaalTree Labs](https://taaltreelabs.com).
