/**
 * `SchemaNode` -> the JSON Schema dialect Apple's `GenerationSchema` decodes.
 *
 * DECISIONS.md D23 (which validates D6): `GenerationSchema` is `Codable` and
 * decodes a JSON-Schema-shaped document directly, so the route from a
 * developer's schema to a native one is *normalize in TypeScript, then
 * `JSONDecoder` in Swift* — no `DynamicGenerationSchema` tree-walk across the
 * bridge. What that decoder wants is a slightly unusual dialect, all of it
 * measured against the framework:
 *
 * - every object node needs `title`, `additionalProperties` and `required`,
 *   plus Apple's `x-order` extension giving property order (omitting
 *   `x-order` or `additionalProperties` is `keyNotFound`);
 * - `$defs`/`$ref` are supported but unnecessary — nested schemas can be
 *   inline, and the core normalizer has already inlined every `$ref`;
 * - `minimum`/`maximum`, `minItems`/`maxItems`, `enum` and `const` all
 *   survive the decode (verified by re-encoding the decoded schema in
 *   `harness/Sources/Runner/SchemaChecks.swift`).
 *
 * The one thing this file rejects that the *decoder* accepts is `pattern`:
 * measured on AFM 3 Core Advanced, a schema carrying a `pattern` decodes and
 * then fails generation with `LanguageModelError.unsupportedGenerationGuide`
 * (`harness/.../ConstraintMatrixChecks.swift`). Rejecting it here means the
 * developer hears about it at the call site instead of one generation later.
 * That asymmetry is exactly why the normalizer is in `core` and the encoder is
 * here: what this *model* can generate is not a portable fact.
 */

import { LLMError, normalizeJsonSchema, type JsonSchema, type SchemaNode } from '../core';

/** JSON document, as the native decoder will read it. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function invalid(message: string, providerId: string): LLMError {
  return new LLMError({ code: 'invalidRequest' }, { message, providerId });
}

/**
 * Validate a developer's JSON Schema and encode it for the bridge.
 *
 * @param label - what this schema is, for error messages (`'schema'`, or
 * `'the parameters for tool "getWeather"'`).
 * @returns the JSON text to hand to Swift.
 */
export function encodeAppleSchema(
  schema: JsonSchema,
  options: { readonly providerId: string; readonly label: string; readonly rootName?: string }
): string {
  const { providerId, label, rootName } = options;
  const normalized = normalizeJsonSchema(schema, {
    providerId,
    ...(rootName !== undefined ? { rootName } : {}),
  });
  const document = encodeNode(normalized.root, { providerId, label, path: label });
  return JSON.stringify(document);
}

interface EncodeContext {
  readonly providerId: string;
  readonly label: string;
  readonly path: string;
}

function encodeNode(node: SchemaNode, context: EncodeContext): JsonValue {
  switch (node.kind) {
    case 'object': {
      const properties: Record<string, JsonValue> = {};
      const required: string[] = [];
      const order: string[] = [];
      for (const property of node.properties) {
        properties[property.name] = encodeNode(property.schema, {
          ...context,
          path: `${context.path}.${property.name}`,
        });
        order.push(property.name);
        if (property.required) required.push(property.name);
      }
      return {
        type: 'object',
        title: node.name,
        ...(node.description !== undefined ? { description: node.description } : {}),
        properties,
        // All four are required by the decoder, `required: []` included: an
        // object whose every property is optional still needs the key.
        required,
        'x-order': order,
        additionalProperties: false,
      };
    }
    case 'array':
      return {
        type: 'array',
        ...(node.description !== undefined ? { description: node.description } : {}),
        items: encodeNode(node.items, { ...context, path: `${context.path}[]` }),
        ...(node.minItems !== undefined ? { minItems: node.minItems } : {}),
        ...(node.maxItems !== undefined ? { maxItems: node.maxItems } : {}),
      };
    case 'string': {
      if (node.pattern !== undefined) {
        throw invalid(
          `\`pattern\` is not supported by the on-device model (at ${context.path}). The schema ` +
            'decodes but generation then fails with `unsupportedGenerationGuide`, so the ' +
            'constraint is rejected here rather than after a wasted generation. Use an `enum` ' +
            'for a closed set of values, or validate the string yourself.',
          context.providerId
        );
      }
      return {
        type: 'string',
        ...(node.description !== undefined ? { description: node.description } : {}),
        ...(node.enum !== undefined ? { enum: [...node.enum] } : {}),
        ...(node.const !== undefined ? { const: node.const } : {}),
      };
    }
    case 'integer':
    case 'number':
      return {
        type: node.kind,
        ...(node.description !== undefined ? { description: node.description } : {}),
        ...(node.minimum !== undefined ? { minimum: node.minimum } : {}),
        ...(node.maximum !== undefined ? { maximum: node.maximum } : {}),
      };
    case 'boolean':
      return {
        type: 'boolean',
        ...(node.description !== undefined ? { description: node.description } : {}),
      };
  }
}
