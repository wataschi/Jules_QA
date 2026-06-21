import { describe, expect, it } from 'vitest';
import { parseJsonFromLlm } from '../../../src/server/ai-assistant.js';

describe('parseJsonFromLlm', () => {
  it('parses raw JSON', () => {
    expect(parseJsonFromLlm('{"ideas":["a"]}')).toEqual({ ideas: ['a'] });
  });

  it('parses fenced JSON', () => {
    expect(parseJsonFromLlm('```json\n{"ideas":["b"]}\n```')).toEqual({ ideas: ['b'] });
  });
});
