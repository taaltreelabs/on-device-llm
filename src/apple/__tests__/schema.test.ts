/**
 * The Apple encoding: the dialect `GenerationSchema`'s `Codable` decode
 * requires, and the one rejection that is Apple-specific rather than portable.
 *
 * The fixtures here are the same documents
 * `harness/Sources/Runner/SchemaChecks.swift` hands to the real framework, so a
 * drift between this encoder and what actually decodes shows up as a harness
 * failure rather than as a runtime surprise on a device.
 */
import { describe, expect, it } from 'vitest';

import { isLLMError, type JsonSchema } from '../../core';
import { encodeAppleSchema } from '../schema';

function encode(schema: JsonSchema): Record<string, unknown> {
  return JSON.parse(encodeAppleSchema(schema, { providerId: 'apple', label: 'schema' })) as Record<
    string,
    unknown
  >;
}

describe('encodeAppleSchema', () => {
  it('emits title, required, x-order and additionalProperties on every object node', () => {
    const document = encode({
      type: 'object',
      title: 'Person',
      properties: {
        name: { type: 'string' },
        nickname: { type: 'string' },
        address: {
          type: 'object',
          title: 'PersonAddress',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
      required: ['name', 'address'],
    });

    expect(document).toMatchObject({
      type: 'object',
      title: 'Person',
      required: ['name', 'address'],
      'x-order': ['name', 'nickname', 'address'],
      additionalProperties: false,
    });
    // The decoder needs all four keys on the nested node too — `keyNotFound`
    // otherwise, which is the failure this test exists to prevent.
    expect((document['properties'] as Record<string, unknown>)['address']).toMatchObject({
      type: 'object',
      title: 'PersonAddress',
      required: ['city'],
      'x-order': ['city'],
      additionalProperties: false,
    });
  });

  it('keeps `required: []` rather than omitting the key', () => {
    const document = encode({ type: 'object', properties: { a: { type: 'string' } } });
    expect(document['required']).toEqual([]);
    expect(Object.keys(document)).toContain('required');
  });

  it('carries the constraints the framework honours', () => {
    const document = encode({
      type: 'object',
      title: 'Thing',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 9 },
        ratio: { type: 'number', minimum: 0, maximum: 1 },
        colour: { type: 'string', enum: ['red', 'blue'] },
        kind: { type: 'string', const: 'fixed' },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
        flag: { type: 'boolean' },
      },
      required: ['count', 'ratio', 'colour', 'kind', 'tags', 'flag'],
    });
    const properties = document['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['count']).toEqual({ type: 'integer', minimum: 1, maximum: 9 });
    expect(properties['ratio']).toEqual({ type: 'number', minimum: 0, maximum: 1 });
    expect(properties['colour']).toEqual({ type: 'string', enum: ['red', 'blue'] });
    expect(properties['kind']).toEqual({ type: 'string', const: 'fixed' });
    expect(properties['tags']).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 3,
    });
    expect(properties['flag']).toEqual({ type: 'boolean' });
  });

  it('rejects `pattern`: it decodes, then fails generation on this model', () => {
    try {
      encode({
        type: 'object',
        properties: { code: { type: 'string', pattern: '[0-9]{4}' } },
        required: ['code'],
      });
    } catch (error) {
      expect(isLLMError(error, 'invalidRequest')).toBe(true);
      expect((error as Error).message).toMatch(/`pattern` is not supported/);
      expect((error as Error).message).toMatch(/unsupportedGenerationGuide/);
      expect((error as Error).message).toMatch(/schema\.code/);
      return;
    }
    throw new Error('expected `pattern` to be rejected');
  });

  it('names the root from `rootName` when the schema has no title', () => {
    const json = encodeAppleSchema(
      { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      { providerId: 'apple', label: 'tool parameters', rootName: 'getWeatherArguments' }
    );
    expect((JSON.parse(json) as { title: string }).title).toBe('getWeatherArguments');
  });

  it('encodes a no-argument tool as an empty object carrying every key the decoder needs', () => {
    const json = encodeAppleSchema(
      { type: 'object', properties: {}, additionalProperties: false },
      {
        providerId: 'apple',
        label: 'tool parameters',
        rootName: 'getBatteryLevelArguments',
        allowEmptyRootObject: true,
      }
    );
    // The exact document harness/Sources/Runner/ToolChecks.swift verifies against the live model.
    expect(JSON.parse(json)).toEqual({
      type: 'object',
      title: 'getBatteryLevelArguments',
      properties: {},
      required: [],
      'x-order': [],
      additionalProperties: false,
    });
    expect(() => encode({ type: 'object', properties: {} })).toThrowError(/at least one property/);
  });

  it('passes the normalizer rejections through with the schema label in the path', () => {
    try {
      encodeAppleSchema(
        { type: 'object', properties: { a: { type: 'string', minLength: 2 } }, required: ['a'] },
        { providerId: 'apple', label: 'schema' }
      );
    } catch (error) {
      expect((error as Error).message).toMatch(/`minLength`/);
      return;
    }
    throw new Error('expected `minLength` to be rejected');
  });
});
