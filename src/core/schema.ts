/**
 * JSON Schema -> a small, validated intermediate form every provider can
 * encode for its own backend.
 *
 * Why this lives in `core` and not in `apple` (docs/plan.md §2): the *shape*
 * of the supported subset — objects, arrays, strings, numbers, booleans,
 * enums, optional fields, nesting, and the handful of constraints that
 * survive — is not an Apple fact. A future Android provider and any
 * third-party provider face the same problem: take a developer's JSON Schema,
 * reject what cannot be honoured *loudly*, and hand the rest to a backend in
 * whatever dialect it wants. Only that last step is provider-specific, and it
 * lives in `src/apple/schema.ts`.
 *
 * The rule this file exists to enforce (docs/plan.md §4): **never silently
 * drop a constraint.** A schema that asks for `minLength: 3` and gets a
 * one-character string back is worse than a schema that was rejected, because
 * the developer believes the constraint is in force. So anything outside the
 * supported set throws `invalidRequest` naming the keyword and its path.
 *
 * Zero dependencies, pure, and unit-testable in Node — no schema library, no
 * device (DECISIONS.md D23).
 */

import { LLMError } from './errors';
import type { JsonSchema } from './generation';

/** A validated schema node. The `kind` discriminant is the provider's switch. */
export type SchemaNode = ObjectNode | ArrayNode | StringNode | NumberNode | BooleanNode;

/** One property of an {@link ObjectNode}. */
export interface SchemaProperty {
  readonly name: string;
  /** `false` when the property is absent from the schema's `required` list. */
  readonly required: boolean;
  readonly schema: SchemaNode;
}

export interface ObjectNode {
  readonly kind: 'object';
  /**
   * A name for this node. Taken from `title` when the developer supplied one,
   * otherwise derived from the property path — Apple's decoder requires one on
   * every object node, and a stable derivation beats asking developers to
   * title every nested object.
   */
  readonly name: string;
  readonly description?: string;
  /** In declaration order, which is the order the model is asked to generate. */
  readonly properties: readonly SchemaProperty[];
}

export interface ArrayNode {
  readonly kind: 'array';
  readonly description?: string;
  readonly items: SchemaNode;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface StringNode {
  readonly kind: 'string';
  readonly description?: string;
  /** A closed set of permitted values. */
  readonly enum?: readonly string[];
  /** A single permitted value (JSON Schema `const`). */
  readonly const?: string;
  /** A regular expression the value must match. */
  readonly pattern?: string;
}

export interface NumberNode {
  /** `integer` and `number` stay distinct: the model generates differently for each. */
  readonly kind: 'integer' | 'number';
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface BooleanNode {
  readonly kind: 'boolean';
  readonly description?: string;
}

/**
 * Keywords that carry no generation semantics and are dropped without
 * complaint. Documented here rather than silently ignored, because "dropped
 * with a documented list" and "silently dropped" are different promises.
 *
 * `default` is on the list on purpose: nothing in the generation path can
 * honour it (the model fills every required field, and an optional field it
 * omits stays omitted), so accepting it would be a lie either way — but it is
 * harmless annotation, not a constraint anyone can observe being violated.
 */
export const DROPPED_ANNOTATIONS: readonly string[] = [
  '$comment',
  '$id',
  '$schema',
  'default',
  'deprecated',
  'examples',
  'readOnly',
  'writeOnly',
];

/** Keywords that change what counts as a valid value, and cannot be honoured. */
const UNSUPPORTED_CONSTRAINTS: readonly string[] = [
  'allOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'dependentRequired',
  'propertyNames',
  'patternProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'prefixItems',
  'contains',
  'minContains',
  'maxContains',
  'uniqueItems',
  'minLength',
  'maxLength',
  'format',
  'multipleOf',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minProperties',
  'maxProperties',
  'nullable',
];

/** A keyword that was dropped rather than honoured, with where it was. */
export interface DroppedKeyword {
  readonly path: string;
  readonly keyword: string;
}

/** The outcome of {@link normalizeJsonSchema}. */
export interface NormalizedSchema {
  readonly root: SchemaNode;
  /** Annotations that were dropped. Never constraints — those throw. */
  readonly dropped: readonly DroppedKeyword[];
}

/** Options for {@link normalizeJsonSchema}. */
export interface NormalizeSchemaOptions {
  /** Name for the root node when the schema has no `title`. Defaults to `'Output'`. */
  readonly rootName?: string;
  /** Provider id attached to the thrown `LLMError`. */
  readonly providerId?: string;
  /**
   * Accept a root object with no properties. Off by default, because a
   * structured-output schema with nothing to generate is a mistake; on for
   * tool parameters, where `{ type: 'object', properties: {} }` is how a tool
   * that takes no arguments is declared. Nested objects still need at least
   * one property.
   */
  readonly allowEmptyRootObject?: boolean;
}

function fail(path: string, message: string, providerId: string | undefined): never {
  throw new LLMError(
    { code: 'invalidRequest' },
    {
      message: `${message} (at ${path})`,
      ...(providerId !== undefined ? { providerId } : {}),
    }
  );
}

/**
 * Validate and normalize a developer-supplied JSON Schema.
 *
 * Supported: `object` (with `properties`, `required`, nesting), `array` (with
 * `items`, `minItems`, `maxItems`), `string` (with `enum` of strings, `const`,
 * `pattern`), `integer`/`number` (with `minimum`, `maximum`), `boolean`, and
 * non-recursive `$ref` into `$defs`/`definitions`, which is inlined.
 *
 * Rejected as `invalidRequest`, each naming the construct and its path:
 * `allOf`/`oneOf`/`not`/conditionals, type unions (`type: ['string','null']`),
 * recursive `$ref`, tuple-form arrays, non-string enums, `additionalProperties:
 * true`, and every constraint in {@link UNSUPPORTED_CONSTRAINTS} — the last
 * group because the backends we target accept the keyword and then ignore it,
 * which is the one failure mode a developer cannot see.
 *
 * `oneOf` is rejected rather than "trivially converted": the one conversion
 * that would be safe (a list of string `const`s) is already expressible as
 * `enum`, and guessing at the rest would be exactly the silent reinterpretation
 * this function exists to prevent.
 */
export function normalizeJsonSchema(
  schema: JsonSchema,
  options: NormalizeSchemaOptions = {}
): NormalizedSchema {
  const providerId = options.providerId;
  const dropped: DroppedKeyword[] = [];
  const defs = collectDefs(schema);

  const root = normalizeNode(schema, {
    path: 'schema',
    name: typeof schema.title === 'string' ? schema.title : (options.rootName ?? 'Output'),
    defs,
    dropped,
    providerId,
    visiting: new Set<string>(),
    allowEmptyObject: options.allowEmptyRootObject === true,
  });

  return { root, dropped };
}

interface Context {
  readonly path: string;
  /** Name to give this node if it is an object and has no `title`. */
  readonly name: string;
  readonly defs: Readonly<Record<string, JsonSchema>>;
  readonly dropped: DroppedKeyword[];
  readonly providerId: string | undefined;
  /** `$ref` names currently being expanded, so a cycle is an error, not a hang. */
  readonly visiting: Set<string>;
  /** Whether this node may be an object with no properties (the root of tool parameters only). */
  readonly allowEmptyObject: boolean;
}

function collectDefs(schema: JsonSchema): Record<string, JsonSchema> {
  const defs: Record<string, JsonSchema> = {};
  for (const key of ['$defs', 'definitions'] as const) {
    const group = schema[key];
    if (typeof group === 'object' && group !== null) {
      for (const [name, value] of Object.entries(group as Record<string, JsonSchema>)) {
        defs[name] = value;
      }
    }
  }
  return defs;
}

function normalizeNode(node: JsonSchema, context: Context): SchemaNode {
  if (typeof node !== 'object' || node === null) {
    fail(context.path, 'Expected a JSON Schema object', context.providerId);
  }

  const ref = node['$ref'];
  if (typeof ref === 'string') {
    return normalizeRef(ref, node, context);
  }

  for (const keyword of UNSUPPORTED_CONSTRAINTS) {
    if (node[keyword] !== undefined) {
      fail(
        context.path,
        `\`${keyword}\` is not supported by this provider's structured output. ` +
          'It would be accepted and then ignored, so the request is rejected instead of ' +
          'returning output that silently violates it',
        context.providerId
      );
    }
  }
  for (const keyword of DROPPED_ANNOTATIONS) {
    if (node[keyword] !== undefined) {
      context.dropped.push({ path: context.path, keyword });
    }
  }

  const type = resolveType(node, context);
  switch (type) {
    case 'object':
      return normalizeObject(node, context);
    case 'array':
      return normalizeArray(node, context);
    case 'string':
      return normalizeString(node, context);
    case 'integer':
    case 'number':
      return normalizeNumber(node, type, context);
    case 'boolean':
      return { kind: 'boolean', ...describe(node) };
    case 'null':
      fail(
        context.path,
        '`null` is not a supported type. Model an absent value as an optional property ' +
          '(omit it from `required`) instead',
        context.providerId
      );
      break;
    default:
      fail(
        context.path,
        `Unsupported \`type\`: ${JSON.stringify(type)}. Supported types are object, array, ` +
          'string, number, integer and boolean',
        context.providerId
      );
  }
}

function normalizeRef(ref: string, node: JsonSchema, context: Context): SchemaNode {
  const prefixes = ['#/$defs/', '#/definitions/'];
  const prefix = prefixes.find((candidate) => ref.startsWith(candidate));
  if (prefix === undefined) {
    fail(
      context.path,
      `Unsupported \`$ref\`: ${JSON.stringify(ref)}. Only local references into ` +
        '`$defs`/`definitions` are supported',
      context.providerId
    );
  }
  const name = ref.slice(prefix.length);
  const target = context.defs[name];
  if (target === undefined) {
    fail(context.path, `\`$ref\` points at an undefined definition: ${name}`, context.providerId);
  }
  if (context.visiting.has(name)) {
    // Not a limitation we could code around: a recursive schema has no finite
    // expansion, and Apple's `fm serve` is on record hanging on one
    // (DECISIONS.md D8).
    fail(
      context.path,
      `Recursive \`$ref\` to "${name}". A schema that refers to itself has no finite ` +
        'expansion and is not supported',
      context.providerId
    );
  }
  const visiting = new Set(context.visiting);
  visiting.add(name);
  const merged: JsonSchema =
    typeof node.description === 'string' && target.description === undefined
      ? { ...target, description: node.description }
      : target;
  return normalizeNode(merged, { ...context, visiting, name: context.name || name });
}

function resolveType(node: JsonSchema, context: Context): string {
  const type = node.type;
  if (Array.isArray(type)) {
    fail(
      context.path,
      `A \`type\` array (${JSON.stringify(type)}) is not supported. Model an absent value as ` +
        'an optional property instead of a nullable one',
      context.providerId
    );
  }
  if (typeof type === 'string') return type;
  if (type !== undefined) {
    fail(context.path, '`type` must be a string', context.providerId);
  }
  // Inferable: a bare enum or const of strings is unambiguous.
  if (Array.isArray(node.enum) || typeof node['const'] === 'string') return 'string';
  if (node.properties !== undefined) return 'object';
  if (node.items !== undefined) return 'array';
  fail(
    context.path,
    'Missing `type`. Every node needs one (the on-device model generates by type, so ' +
      'there is nothing sensible to assume)',
    context.providerId
  );
}

function describe(node: JsonSchema): { description?: string } {
  return typeof node.description === 'string' && node.description !== ''
    ? { description: node.description }
    : {};
}

function normalizeObject(node: JsonSchema, context: Context): ObjectNode {
  const properties = node.properties;
  if (typeof properties !== 'object' || properties === null) {
    fail(
      context.path,
      'An object schema needs `properties`. A free-form object cannot be generated: the model ' +
        'is told which fields to produce',
      context.providerId
    );
  }
  const entries = Object.entries(properties as Record<string, JsonSchema>);
  if (entries.length === 0 && !context.allowEmptyObject) {
    fail(context.path, 'An object schema needs at least one property', context.providerId);
  }
  if (node.additionalProperties === true) {
    fail(
      context.path,
      '`additionalProperties: true` is not supported: generated objects contain exactly the ' +
        'declared properties. Remove it, or declare the extra fields',
      context.providerId
    );
  }

  const required = node.required;
  if (required !== undefined && !Array.isArray(required)) {
    fail(context.path, '`required` must be an array of property names', context.providerId);
  }
  const requiredNames = new Set((required ?? []) as readonly string[]);
  for (const name of requiredNames) {
    if (!(name in (properties as Record<string, JsonSchema>))) {
      fail(
        context.path,
        `\`required\` lists "${name}", which is not among the properties`,
        context.providerId
      );
    }
  }

  const title = typeof node.title === 'string' && node.title !== '' ? node.title : context.name;

  return {
    kind: 'object',
    name: sanitizeName(title),
    ...describe(node),
    properties: entries.map(([name, child]) => ({
      name,
      required: requiredNames.has(name),
      schema: normalizeNode(child, {
        ...context,
        path: `${context.path}.${name}`,
        name: `${sanitizeName(title)}_${sanitizeName(name)}`,
        allowEmptyObject: false,
      }),
    })),
  };
}

function normalizeArray(node: JsonSchema, context: Context): ArrayNode {
  const items = node.items;
  if (Array.isArray(items)) {
    fail(
      context.path,
      'Tuple-form `items` (an array of schemas) is not supported. Use a single item schema',
      context.providerId
    );
  }
  if (typeof items !== 'object' || items === null) {
    fail(context.path, 'An array schema needs an `items` schema', context.providerId);
  }

  const minItems = integerKeyword(node, 'minItems', context);
  const maxItems = integerKeyword(node, 'maxItems', context);
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    fail(
      context.path,
      `\`minItems\` (${minItems}) exceeds \`maxItems\` (${maxItems})`,
      context.providerId
    );
  }

  return {
    kind: 'array',
    ...describe(node),
    items: normalizeNode(items as JsonSchema, {
      ...context,
      path: `${context.path}[]`,
      name: `${context.name}_Item`,
      allowEmptyObject: false,
    }),
    ...(minItems !== undefined ? { minItems } : {}),
    ...(maxItems !== undefined ? { maxItems } : {}),
  };
}

function normalizeString(node: JsonSchema, context: Context): StringNode {
  const values = node.enum;
  let enumValues: readonly string[] | undefined;
  if (values !== undefined) {
    if (!Array.isArray(values) || values.length === 0) {
      fail(context.path, '`enum` must be a non-empty array', context.providerId);
    }
    if (!values.every((value) => typeof value === 'string')) {
      fail(
        context.path,
        '`enum` values must all be strings. A numeric or mixed enum is not supported',
        context.providerId
      );
    }
    enumValues = values as readonly string[];
  }

  const constant = node['const'];
  if (constant !== undefined && typeof constant !== 'string') {
    fail(context.path, '`const` must be a string', context.providerId);
  }

  const pattern = node.pattern;
  if (pattern !== undefined && typeof pattern !== 'string') {
    fail(context.path, '`pattern` must be a string', context.providerId);
  }

  return {
    kind: 'string',
    ...describe(node),
    ...(enumValues !== undefined ? { enum: enumValues } : {}),
    ...(typeof constant === 'string' ? { const: constant } : {}),
    ...(typeof pattern === 'string' ? { pattern } : {}),
  };
}

function normalizeNumber(
  node: JsonSchema,
  kind: 'integer' | 'number',
  context: Context
): NumberNode {
  const minimum = numberKeyword(node, 'minimum', context);
  const maximum = numberKeyword(node, 'maximum', context);
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    fail(
      context.path,
      `\`minimum\` (${minimum}) exceeds \`maximum\` (${maximum})`,
      context.providerId
    );
  }
  return {
    kind,
    ...describe(node),
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
  };
}

function numberKeyword(node: JsonSchema, keyword: string, context: Context): number | undefined {
  const value = node[keyword];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(context.path, `\`${keyword}\` must be a finite number`, context.providerId);
  }
  return value;
}

function integerKeyword(node: JsonSchema, keyword: string, context: Context): number | undefined {
  const value = numberKeyword(node, keyword, context);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    fail(context.path, `\`${keyword}\` must be a non-negative integer`, context.providerId);
  }
  return value;
}

/**
 * Object names cross into a native schema document where they identify a type,
 * so they are restricted to what such an identifier can be. Substitution rather
 * than rejection: a developer's `title` is prose, and failing a request over a
 * space in it would be officious.
 */
function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '');
  return cleaned === '' ? 'Value' : cleaned;
}
