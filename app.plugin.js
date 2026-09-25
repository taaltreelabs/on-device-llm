// Entry point Expo resolves for `"plugins": ["@taaltreelabs/on-device-llm"]`.
// The plugin itself is compiled from src/plugin (see DECISIONS.md D41).
module.exports = require('./build/plugin').default;
