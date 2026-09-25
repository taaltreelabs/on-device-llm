/**
 * The normalizer's contract: accept the documented subset, reject everything
 * else *by name and path*, and never quietly reinterpret a constraint.
 */
import { describe, expect, it } from 'vitest';

import { isLLMError } from '../errors';
import type { JsonSchema } from '../generation';
import { normalizeJsonSchema, type ObjectNode } from '../schema';

function reject(schema: JsonSchema): string {
  try {
    normalizeJsonSchema(schema, { providerId: 'test' });
  } catch (error) {
    expect(isLLMError(error, 'invalidRequest')).toBe(true);
    return (error as Error).message;
  }
  throw new Error('expected the schema to be rejected');
}

const person: JsonSchema = {
  type: 'object',
  title: 'Person',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer', minimum: 0, maximum: 120 },
    favoriteColor: { type: 'string', enum: ['red', 'green', 'blue'] },
    nickname: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
    address: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
  required: ['name', 'age', 'favoriteColor', 'tags', 'address'],
};

describe('normalizeJsonSchema', () => {
  it('normalizes the documented subset, preserving declaration order', () => {
    const { root } = normalizeJsonSchema(person);
    expect(root.kind).toBe('object');
    const object = root as ObjectNode;
    expect(object.name).toBe('Person');
    expect(object.properties.map((property) => property.name)).toEqual([
      'name',
      'age',
      'favoriteColor',
      'nickname',
      'tags',
      'address',
    ]);
    // Optional is "absent from required", not a keyword of its own.
    expect(object.properties.find((p) => p.name === 'nickname')?.required).toBe(false);
    expect(object.properties.find((p) => p.name === 'name')?.required).toBe(true);
    expect(object.properties.find((p) => p.name === 'age')?.schema).toEqual({
      kind: 'integer',
      minimum: 0,
      maximum: 120,
    });
    expect(object.properties.find((p) => p.name === 'tags')?.schema).toEqual({
      kind: 'array',
      items: { kind: 'string' },
      minItems: 1,
      maxItems: 3,
    });
  });

  it('names a nested object after its path when it has no title', () => {
    const { root } = normalizeJsonSchema(person);
    const address = (root as ObjectNode).properties.find((p) => p.name === 'address');
    expect((address?.schema as ObjectNode).name).toBe('Person_address');
  });

  it('inlines a non-recursive $ref and rejects a recursive one', () => {
    const withRef: JsonSchema = {
      type: 'object',
      title: 'Root',
      $defs: { Leaf: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] } },
      properties: { leaf: { $ref: '#/$defs/Leaf' } },
      required: ['leaf'],
    };
    const { root } = normalizeJsonSchema(withRef);
    const leaf = (root as ObjectNode).properties[0]?.schema as ObjectNode;
    expect(leaf.kind).toBe('object');
    expect(leaf.properties[0]?.name).toBe('v');

    const recursive: JsonSchema = {
      type: 'object',
      title: 'Node',
      $defs: {
        Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } }, required: [] },
      },
      properties: { next: { $ref: '#/$defs/Node' } },
    };
    expect(reject(recursive)).toMatch(/Recursive `\$ref`/);
  });

  it('drops annotations, recording where', () => {
    const { dropped } = normalizeJsonSchema({
      type: 'object',
      title: 'A',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { a: { type: 'string', examples: ['x'], default: 'y' } },
      required: ['a'],
    });
    expect(dropped).toEqual([
      { path: 'schema', keyword: '$schema' },
      { path: 'schema.a', keyword: 'default' },
      { path: 'schema.a', keyword: 'examples' },
    ]);
  });

  it.each([
    ['allOf', { type: 'object', properties: { a: { allOf: [{ type: 'string' }] } } }],
    ['oneOf', { type: 'object', properties: { a: { oneOf: [{ type: 'string' }] } } }],
    ['minLength', { type: 'object', properties: { a: { type: 'string', minLength: 3 } } }],
    ['maxLength', { type: 'object', properties: { a: { type: 'string', maxLength: 3 } } }],
    ['format', { type: 'object', properties: { a: { type: 'string', format: 'email' } } }],
    ['multipleOf', { type: 'object', properties: { a: { type: 'number', multipleOf: 2 } } }],
    ['uniqueItems', { type: 'array', items: { type: 'string' }, uniqueItems: true }],
    ['nullable', { type: 'object', properties: { a: { type: 'string', nullable: true } } }],
  ] satisfies [string, JsonSchema][])(
    'rejects `%s`, naming the keyword and the path',
    (keyword, schema) => {
      const message = reject(schema);
      expect(message).toContain(`\`${keyword}\``);
      expect(message).toMatch(/at schema/);
    }
  );

  it('rejects a nullable type union rather than guessing', () => {
    expect(reject({ type: ['string', 'null'] as unknown as string })).toMatch(
      /`type` array.*optional property/s
    );
  });

  it('rejects a non-string enum', () => {
    expect(reject({ type: 'object', properties: { a: { enum: [1, 2] } } })).toMatch(
      /`enum` values must all be strings/
    );
  });

  it('rejects tuple-form items', () => {
    expect(reject({ type: 'array', items: [{ type: 'string' }] as unknown as JsonSchema })).toMatch(
      /Tuple-form `items`/
    );
  });

  it('rejects additionalProperties: true, which the model cannot honour', () => {
    expect(
      reject({
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: true,
      })
    ).toMatch(/additionalProperties: true/);
  });

  it('rejects an object with no properties, and a required name that is not one', () => {
    expect(reject({ type: 'object', properties: {} })).toMatch(/at least one property/);
    expect(
      reject({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] })
    ).toMatch(/lists "b"/);
  });

  it('accepts an empty root object only when asked to (tool parameters with no arguments)', () => {
    const empty: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };
    const { root } = normalizeJsonSchema(empty, { allowEmptyRootObject: true, rootName: 'Args' });
    expect(root).toMatchObject({ kind: 'object', name: 'Args', properties: [] });
    // The allowance is for the root only: a nested empty object is still a mistake.
    expect(() =>
      normalizeJsonSchema(
        {
          type: 'object',
          properties: {
            options: { type: 'object', properties: {} },
            list: { type: 'array', items: { type: 'object', properties: {} } },
          },
        },
        { allowEmptyRootObject: true }
      )
    ).toThrowError(/at least one property \(at schema\.options\)/);
  });

  it('rejects inverted bounds', () => {
    expect(reject({ type: 'integer', minimum: 10, maximum: 1 })).toMatch(/exceeds `maximum`/);
    expect(reject({ type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 2 })).toMatch(
      /exceeds `maxItems`/
    );
  });

  it('requires a type where none can be inferred', () => {
    expect(reject({ description: 'a mystery' })).toMatch(/Missing `type`/);
  });

  it('infers string for a bare enum, and object/array from their keywords', () => {
    expect(normalizeJsonSchema({ enum: ['a', 'b'] }).root).toEqual({
      kind: 'string',
      enum: ['a', 'b'],
    });
    expect(normalizeJsonSchema({ items: { type: 'string' } }).root.kind).toBe('array');
    expect(normalizeJsonSchema({ properties: { a: { type: 'string' } } }).root.kind).toBe('object');
  });

  it('sanitizes a prose title into a usable type name instead of failing', () => {
    const { root } = normalizeJsonSchema({
      type: 'object',
      title: 'A person!',
      properties: { a: { type: 'string' } },
      required: ['a'],
    });
    expect((root as ObjectNode).name).toBe('A_person_');
  });
});
