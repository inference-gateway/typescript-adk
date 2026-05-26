import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OUTPUT_FILE,
  SCHEMA_REF,
  check,
} from '../scripts/generate-a2a-types.ts';

describe('A2A generated types', () => {
  it('file exists at the expected path', () => {
    expect(existsSync(OUTPUT_FILE)).toBe(true);
  });

  it('header records the pinned schema commit', () => {
    const content = readFileSync(OUTPUT_FILE, 'utf8');
    expect(
      content.startsWith('// Code generated from A2A schema. DO NOT EDIT.')
    ).toBe(true);
    expect(content).toContain(SCHEMA_REF);
  });

  it(
    'matches the upstream schema (no drift)',
    { timeout: 30_000 },
    async () => {
      const { ok } = await check();
      if (!ok) {
        throw new Error(
          'Generated A2A types are out of date. Run `pnpm generate:types` and commit the result.'
        );
      }
      expect(ok).toBe(true);
    }
  );
});
