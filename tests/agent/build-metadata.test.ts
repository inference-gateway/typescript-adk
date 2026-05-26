import { describe, expect, it } from 'vitest';
import {
  applyBuildMetadata,
  buildMetadata,
} from '../../src/agent/build-metadata.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

function baseCard(): AgentCard {
  return {
    name: 'base-name',
    description: 'base description',
    version: '0.0.1',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: {},
    skills: [],
  };
}

describe('buildMetadata', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(buildMetadata)).toBe(true);
  });

  it('exposes name, description, and version as strings', () => {
    expect(typeof buildMetadata.name).toBe('string');
    expect(typeof buildMetadata.description).toBe('string');
    expect(typeof buildMetadata.version).toBe('string');
  });
});

describe('applyBuildMetadata', () => {
  it('overrides each non-empty field', () => {
    const result = applyBuildMetadata(baseCard(), {
      name: 'injected-name',
      description: 'injected description',
      version: '9.9.9',
    });
    expect(result.name).toBe('injected-name');
    expect(result.description).toBe('injected description');
    expect(result.version).toBe('9.9.9');
  });

  it('leaves the original card untouched (returns a new object)', () => {
    const card = baseCard();
    const result = applyBuildMetadata(card, {
      name: 'injected',
      description: '',
      version: '',
    });
    expect(card.name).toBe('base-name');
    expect(result).not.toBe(card);
  });

  it('treats empty strings as no-ops per field', () => {
    const result = applyBuildMetadata(baseCard(), {
      name: '',
      description: 'new desc',
      version: '',
    });
    expect(result.name).toBe('base-name');
    expect(result.description).toBe('new desc');
    expect(result.version).toBe('0.0.1');
  });

  it('returns an unchanged copy when all build values are empty', () => {
    const card = baseCard();
    const result = applyBuildMetadata(card, {
      name: '',
      description: '',
      version: '',
    });
    expect(result).toEqual(card);
  });

  it('uses module-level buildMetadata when none is passed', () => {
    const card = baseCard();
    const result = applyBuildMetadata(card);
    // Empty env defaults preserve the card; with set env they'd override.
    if (
      buildMetadata.name === '' &&
      buildMetadata.description === '' &&
      buildMetadata.version === ''
    ) {
      expect(result).toEqual(card);
    } else {
      expect(result).not.toEqual(card);
    }
  });
});
