import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentCardLoadError,
  AgentCardValidationError,
  loadAgentCardFromFile,
  loadAgentCardFromJSON,
  validateAgentCard,
} from '../../src/agent/card.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

const FIXTURES = resolve(fileURLToPath(import.meta.url), '..', 'fixtures');
const VALID_FIXTURE = join(FIXTURES, 'valid-card.json');
const PLACEHOLDER_FIXTURE = join(FIXTURES, 'card-with-placeholders.json');

function minimalCard(): AgentCard {
  return {
    name: 'agent',
    description: 'desc',
    version: '1.0.0',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: {},
    skills: [],
  };
}

describe('validateAgentCard', () => {
  it('accepts a minimal valid card', () => {
    expect(() => validateAgentCard(minimalCard())).not.toThrow();
  });

  it('rejects non-objects', () => {
    expect(() => validateAgentCard(null)).toThrow(AgentCardValidationError);
    expect(() => validateAgentCard('a string')).toThrow(
      AgentCardValidationError
    );
    expect(() => validateAgentCard([1, 2, 3])).toThrow(
      AgentCardValidationError
    );
  });

  it('rejects when name is missing', () => {
    const card = minimalCard() as Partial<AgentCard>;
    delete card.name;
    expect(() => validateAgentCard(card)).toThrow(/name/);
  });

  it('rejects when description is empty', () => {
    const card = { ...minimalCard(), description: '' };
    expect(() => validateAgentCard(card)).toThrow(/description/);
  });

  it('rejects when version is not a string', () => {
    const card = { ...minimalCard(), version: 1 as unknown as string };
    expect(() => validateAgentCard(card)).toThrow(/version/);
  });

  it('rejects when capabilities is not an object', () => {
    const card = {
      ...minimalCard(),
      capabilities: 'oops' as unknown as AgentCard['capabilities'],
    };
    expect(() => validateAgentCard(card)).toThrow(/capabilities/);
  });

  it('rejects when defaultInputModes is not an array', () => {
    const card = {
      ...minimalCard(),
      defaultInputModes: 'text/plain' as unknown as string[],
    };
    expect(() => validateAgentCard(card)).toThrow(/defaultInputModes/);
  });

  it('rejects when defaultInputModes contains non-strings', () => {
    const card = {
      ...minimalCard(),
      defaultInputModes: ['text/plain', 1] as unknown as string[],
    };
    expect(() => validateAgentCard(card)).toThrow(/defaultInputModes\[1\]/);
  });

  it('rejects when skills is not an array', () => {
    const card = {
      ...minimalCard(),
      skills: { id: 'x' } as unknown as AgentCard['skills'],
    };
    expect(() => validateAgentCard(card)).toThrow(/skills/);
  });

  it('rejects when a skill entry is not an object', () => {
    const card = {
      ...minimalCard(),
      skills: ['not-an-object'] as unknown as AgentCard['skills'],
    };
    expect(() => validateAgentCard(card)).toThrow(/skills\[0\]/);
  });

  it('attaches a field hint on validation errors', () => {
    try {
      validateAgentCard({ ...minimalCard(), name: '' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentCardValidationError);
      expect((err as AgentCardValidationError).field).toBe('name');
    }
  });
});

describe('loadAgentCardFromJSON', () => {
  it('parses and validates a valid card', () => {
    const card = loadAgentCardFromJSON(JSON.stringify(minimalCard()));
    expect(card.name).toBe('agent');
  });

  it('substitutes ${VAR} placeholders from the provided env', () => {
    const json = JSON.stringify({
      ...minimalCard(),
      name: '${AGENT_NAME}',
      description: 'Hello from ${AGENT_ENV}',
    });
    const card = loadAgentCardFromJSON(json, {
      env: { AGENT_NAME: 'my-agent', AGENT_ENV: 'staging' },
    });
    expect(card.name).toBe('my-agent');
    expect(card.description).toBe('Hello from staging');
  });

  it('substitutes placeholders in nested objects and arrays', () => {
    const json = JSON.stringify({
      ...minimalCard(),
      skills: [
        {
          id: '${SKILL_ID}',
          name: 'A skill',
          description: 'Tagged ${TAG}',
        },
      ],
      provider: { organization: '${ORG}' },
    });
    const card = loadAgentCardFromJSON(json, {
      env: { SKILL_ID: 'skill-1', TAG: 'beta', ORG: 'Acme' },
    });
    expect(card.skills[0]).toMatchObject({
      id: 'skill-1',
      description: 'Tagged beta',
    });
    expect(card.provider).toEqual({ organization: 'Acme' });
  });

  it('throws when a placeholder env var is missing', () => {
    const json = JSON.stringify({ ...minimalCard(), name: '${MISSING}' });
    expect(() => loadAgentCardFromJSON(json, { env: {} })).toThrow(
      AgentCardLoadError
    );
    expect(() => loadAgentCardFromJSON(json, { env: {} })).toThrow(/MISSING/);
  });

  it('does not substitute empty string for missing env vars', () => {
    const json = JSON.stringify({ ...minimalCard(), name: '${MISSING}' });
    try {
      loadAgentCardFromJSON(json, { env: {} });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentCardLoadError);
      expect((err as Error).message).not.toMatch(/^Field/);
    }
  });

  it('applies overrides over JSON values', () => {
    const card = loadAgentCardFromJSON(JSON.stringify(minimalCard()), {
      overrides: { name: 'override-name', version: '9.9.9' },
    });
    expect(card.name).toBe('override-name');
    expect(card.version).toBe('9.9.9');
  });

  it('applies overrides after placeholder resolution', () => {
    const json = JSON.stringify({ ...minimalCard(), name: '${AGENT_NAME}' });
    const card = loadAgentCardFromJSON(json, {
      env: { AGENT_NAME: 'from-env' },
      overrides: { name: 'final-name' },
    });
    expect(card.name).toBe('final-name');
  });

  it('throws on malformed JSON', () => {
    expect(() => loadAgentCardFromJSON('not json')).toThrow(AgentCardLoadError);
  });

  it('throws when JSON decodes to a non-object', () => {
    expect(() => loadAgentCardFromJSON('[1,2,3]')).toThrow(
      AgentCardValidationError
    );
    expect(() => loadAgentCardFromJSON('"a string"')).toThrow(
      AgentCardValidationError
    );
  });

  it('throws validation error when required field is missing after merge', () => {
    const card = minimalCard() as Partial<AgentCard>;
    delete card.description;
    expect(() => loadAgentCardFromJSON(JSON.stringify(card))).toThrow(
      AgentCardValidationError
    );
  });
});

describe('loadAgentCardFromFile', () => {
  it('loads a valid card from a JSON file', () => {
    const card = loadAgentCardFromFile(VALID_FIXTURE);
    expect(card.name).toBe('recipe-agent');
    expect(card.skills).toHaveLength(1);
  });

  it('loads a card with placeholders resolved against env', () => {
    const card = loadAgentCardFromFile(PLACEHOLDER_FIXTURE, {
      env: {
        AGENT_NAME: 'planner',
        AGENT_ENV: 'prod',
        AGENT_VERSION: '2.3.1',
        AGENT_ORG: 'Inference Gateway',
      },
    });
    expect(card.name).toBe('planner');
    expect(card.description).toBe('Agent serving environment prod.');
    expect(card.version).toBe('2.3.1');
    expect(card.provider).toEqual({
      organization: 'Inference Gateway',
      url: 'https://example.com/planner',
    });
    expect(card.skills[0]?.id).toBe('planner-skill');
  });

  it('falls back to process.env when no env is provided', () => {
    const previous = process.env['AGENT_NAME'];
    process.env['AGENT_NAME'] = 'from-process-env';
    process.env['AGENT_ENV'] = 'unit-test';
    process.env['AGENT_VERSION'] = '0.0.1';
    process.env['AGENT_ORG'] = 'TestOrg';
    try {
      const card = loadAgentCardFromFile(PLACEHOLDER_FIXTURE);
      expect(card.name).toBe('from-process-env');
    } finally {
      if (previous === undefined) {
        delete process.env['AGENT_NAME'];
      } else {
        process.env['AGENT_NAME'] = previous;
      }
      delete process.env['AGENT_ENV'];
      delete process.env['AGENT_VERSION'];
      delete process.env['AGENT_ORG'];
    }
  });

  it('throws when the file does not exist', () => {
    expect(() =>
      loadAgentCardFromFile(join(FIXTURES, 'does-not-exist.json'))
    ).toThrow(AgentCardLoadError);
  });

  describe('with a temporary directory', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'agent-card-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('throws when the file contents are not valid JSON', () => {
      const path = join(tmpDir, 'bad.json');
      writeFileSync(path, '{not valid');
      expect(() => loadAgentCardFromFile(path)).toThrow(AgentCardLoadError);
    });

    it('throws validation error when a required field is missing', () => {
      const path = join(tmpDir, 'incomplete.json');
      const card = minimalCard() as Partial<AgentCard>;
      delete card.skills;
      writeFileSync(path, JSON.stringify(card));
      expect(() => loadAgentCardFromFile(path)).toThrow(
        AgentCardValidationError
      );
    });
  });
});
