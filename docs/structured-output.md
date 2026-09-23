# Structured output

Pass a JSON Schema as `GenerateRequest.schema` and the result carries a parsed
`object`. The supported subset is small and the rejections are loud, on purpose.

- [Using it](#using-it)
- [The supported subset](#the-supported-subset)
- [What is rejected, and why so loudly](#what-is-rejected-and-why-so-loudly)
- [`pattern` is a special case](#pattern-is-a-special-case)
- [Annotations that are dropped](#annotations-that-are-dropped)
- [Streaming a structured response](#streaming-a-structured-response)
- [Validating a schema ahead of time](#validating-a-schema-ahead-of-time)

## Using it

```ts
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import type { JsonSchema } from '@taaltreelabs/on-device-llm/core';

const WEATHER_REPORT: JsonSchema = {
  type: 'object',
  title: 'WeatherReport',
  properties: {
    city: { type: 'string' },
    tempC: { type: 'number', minimum: -40, maximum: 45 },
    conditions: { type: 'string', enum: ['sunny', 'rainy', 'cloudy', 'snowy'] },
    alerts: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['city', 'tempC', 'conditions'],
  additionalProperties: false,
};

const apple = createAppleProvider();

export async function weatherFor(city: string): Promise<unknown> {
  const result = await apple.generate({
    messages: [{ role: 'user', content: `Give me the current weather in ${city}.` }],
    schema: WEATHER_REPORT,
  });
  return result.object;
}
```

`result.text` is `''` when the provider returned only structured output, so you never have
to null-check it. `result.object` is present **only** when the request carried a schema and
parsing succeeded: a schema request whose output fails to parse is a failure of
expectations, not a partial success, so providers throw `invalidRequest` (carrying the raw
content from Apple's parsing error) rather than returning a result with `object` missing.

A provider that reports `capabilities().structuredOutput === false` must reject a request
carrying a schema as `invalidRequest` rather than silently returning prose.

Note that `useChat` deliberately has **no `schema` option**: it accumulates a text
transcript, and an object has no natural place in a message list. For one schema-shaped
turn inside an otherwise free-text conversation, reach for `useGenerate`.

## The supported subset

| Type | Supported keywords |
| --- | --- |
| `object` | `properties`, `required`, `title`, `description`, nesting, `additionalProperties: false` |
| `array` | `items` (a single schema), `minItems`, `maxItems`, `description` |
| `string` | `enum` (of strings), `const`, `pattern` (see below), `description` |
| `number` / `integer` | `minimum`, `maximum`, `description`. The two stay distinct: the model generates differently for each. |
| `boolean` | `description` |
| `$ref` | Non-recursive references into `$defs` or `definitions`, which are inlined |

Property order is declaration order, and that is the order the model is asked to generate
in. Every object node needs a name; `title` supplies one, and a stable name is derived
from the property path when you do not — better than asking developers to title every
nested object.

This subset is not an Apple fact, which is why `normalizeJsonSchema` lives in `core`. A
future Android provider and any third-party provider face the same problem: take a
developer's JSON Schema, reject what cannot be honored loudly, and hand the rest to a
backend in whatever dialect it wants. Only that last step is provider-specific
(`src/apple/schema.ts` writes Apple's dialect: `title`, `additionalProperties`, `required`
and Apple's `x-order` on every object node).

## What is rejected, and why so loudly

Every one of these throws `LLMError` `invalidRequest`, with the keyword and its path in
the message:

| Rejected | Category |
| --- | --- |
| `allOf`, `oneOf`, `not`, `if`, `then`, `else` | Composition and conditionals |
| `dependentSchemas`, `dependentRequired` | Conditionals |
| `type: ['string', 'null']` | Type unions |
| Recursive `$ref` | Cannot be inlined, and hangs some servers outright |
| `prefixItems`, tuple-form `items` | Positional arrays |
| `contains`, `minContains`, `maxContains`, `uniqueItems` | Array constraints |
| `minLength`, `maxLength`, `format`, `multipleOf` | String and number constraints Apple's decoder accepts and then silently drops |
| `exclusiveMinimum`, `exclusiveMaximum` | Number bounds |
| `minProperties`, `maxProperties`, `propertyNames`, `patternProperties` | Object constraints |
| `unevaluatedProperties`, `unevaluatedItems` | 2020-12 evaluation keywords |
| `nullable` | Not a JSON Schema keyword, and unhonorable |
| Non-string `enum` | Only string enums are expressible |
| `additionalProperties: true` | The generated object would not be constrained |

**The reason for the noise.** A schema that asks for `minLength: 3` and gets a
one-character string back is worse than a schema that was rejected, because the developer
believes the constraint is in force and writes code downstream that assumes it. Silent
constraint dropping is the failure mode this whole file exists to prevent.

That risk is not hypothetical here. Apple's `GenerationSchema` decodes a JSON Schema
document directly, and measurement showed `minLength`, `maxLength`, `format`, and
`multipleOf` disappearing on the way through while `minimum`, `maximum`, `enum`,
`minItems`, and `maxItems` survived intact. Silent dropping turned out to be a property of
those four keywords specifically, not of the decoder — so the normalizer rejects all four
by name and path, and nothing reaches the decoder that it would quietly discard. The Swift
harness (`npm run harness:apple`) keeps the supported/unsupported split honest against the
live model, and is the regression test for a future OS widening or narrowing the set.

## `pattern` is a special case

`pattern` passes the portable normalizer in `core` and is rejected by the **Apple encoder**
specifically. It decodes cleanly, it survives a schema round trip, and then generation
fails with `unsupportedGenerationGuide` on the current on-device model.

"The schema was accepted" and "the model will generate against it" are different
questions, and only the second one matters to a caller. That is a fact about *this model*,
not about JSON Schema, which is exactly why the rejection lives in `src/apple/schema.ts`
and not in `core`. Another provider whose backend honors `pattern` reuses the same
normalizer and simply does not reject it.

## Annotations that are dropped

These carry no generation semantics and are dropped without failing the request:
`$schema`, `$id`, `$comment`, `default`, `deprecated`, `examples`, `readOnly`,
`writeOnly`. They are reported in `normalizeJsonSchema`'s `dropped` array —
"dropped with a documented list" and "silently dropped" are different promises.

`default` is on this list on purpose. Nothing in the generation path can honor it: the
model fills every required field, and an optional field it omits stays omitted. Accepting
it would be a lie either way, but it is a harmless annotation rather than a constraint
anyone can observe being violated.

## Streaming a structured response

Text is append-only, so a delta is well-defined. A partially generated *object* is not: it
changes by having fields filled in and firmed up. So a structured stream emits
`objectSnapshot` events carrying the value so far, each replacing the previous one, and
the final `finish` event carries the authoritative result.

```ts
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import type { JsonSchema } from '@taaltreelabs/on-device-llm/core';

const schema: JsonSchema = {
  type: 'object',
  title: 'Summary',
  properties: { headline: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } },
  required: ['headline'],
  additionalProperties: false,
};

export async function summarize(text: string): Promise<unknown> {
  const apple = createAppleProvider();
  let latest: unknown;

  for await (const event of apple.stream({ messages: [{ role: 'user', content: text }], schema })) {
    switch (event.type) {
      case 'objectSnapshot':
        latest = event.snapshot; // may have missing or incomplete fields
        break;
      case 'finish':
        latest = event.result.object;
        break;
      default:
        break;
    }
  }

  return latest;
}
```

Ignore event types you do not recognize (a `default: break`) rather than throwing.
`toolCall` arrived in a later phase exactly this way, and UIs that rendered text did not
break.

## Validating a schema ahead of time

`normalizeJsonSchema` is exported from `core`, so a schema can be checked in a unit test
— in plain Node, with no device — instead of at the first request on a user's phone:

```ts
import { normalizeJsonSchema, isLLMError, type JsonSchema } from '@taaltreelabs/on-device-llm/core';

export function describeSchema(schema: JsonSchema): string {
  try {
    const { root, dropped } = normalizeJsonSchema(schema, { rootName: 'Output' });
    return `ok: ${root.kind}, ${dropped.length} annotation(s) dropped`;
  } catch (error) {
    if (isLLMError(error)) return `rejected: ${error.message}`;
    throw error;
  }
}
```

The same normalizer validates `ToolDefinition.parameters`, so tool argument schemas obey
exactly these rules too.
