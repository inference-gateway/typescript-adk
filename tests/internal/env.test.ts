import { describe, expect, it } from 'vitest';
import { parseEnvBool } from '../../src/internal/env.js';

describe('parseEnvBool', () => {
  it('accepts 1, true, yes and on, trimmed and case-insensitive', () => {
    for (const raw of ['1', 'true', 'TRUE', ' yes ', 'On']) {
      expect(parseEnvBool(raw)).toBe(true);
    }
  });

  it('rejects everything else, including unset', () => {
    for (const raw of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) {
      expect(parseEnvBool(raw)).toBe(false);
    }
  });
});
