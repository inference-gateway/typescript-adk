import { describe, expect, it } from 'vitest';
import {
  USAGE_EXTENSION_URI,
  activatedExtensions,
  withUsageExtension,
  withoutExtension,
} from '../../src/agent/usage-extension.js';
import type { AgentCard, Task } from '../../src/types/generated/a2a.js';

const OTHER_URI = 'https://example.com/ext/other/v1';

function cardDeclaring(...uris: string[]): AgentCard {
  return {
    capabilities: { extensions: uris.map((uri) => ({ uri })) },
  } as AgentCard;
}

function taskWith(metadata: Record<string, unknown>): Task {
  return {
    id: 't1',
    contextId: 'ctx-1',
    status: { state: 'TASK_STATE_COMPLETED' },
    metadata,
  } as Task;
}

describe('withUsageExtension', () => {
  it('declares the extension once, optional, without touching the input', () => {
    const card = cardDeclaring(OTHER_URI);

    const declared = withUsageExtension(card);

    expect(declared.capabilities.extensions).toEqual([
      { uri: OTHER_URI },
      expect.objectContaining({ uri: USAGE_EXTENSION_URI, required: false }),
    ]);
    expect(withUsageExtension(declared)).toBe(declared);
    expect(card.capabilities.extensions).toHaveLength(1);
  });
});

describe('withoutExtension', () => {
  const uri = 'https://example.com/ext/usage/v1';

  it.each([
    [
      'keeps keys of a lookalike URI and plain keys',
      { [`${uri}/usage`]: 1, [`${uri}-other/key`]: 2, plain: 3 },
      { [`${uri}-other/key`]: 2, plain: 3 },
    ],
    ['drops metadata that ends up empty', { [`${uri}/usage`]: 1 }, undefined],
  ])('%s', (_name, metadata, expected) => {
    const task = taskWith(metadata);

    expect(withoutExtension(task, uri).metadata).toEqual(expected);
    expect(task.metadata).toEqual(metadata);
  });
});

describe('activatedExtensions', () => {
  it.each([
    [undefined, []],
    [USAGE_EXTENSION_URI, [USAGE_EXTENSION_URI]],
    [`${OTHER_URI}, ${USAGE_EXTENSION_URI}`, [USAGE_EXTENSION_URI]],
    ['https://example.com/ext/undeclared/v1', []],
  ])('A2A-Extensions %j activates %j', (header, expected) => {
    const card = withUsageExtension(cardDeclaring());

    expect([...activatedExtensions(header, card)]).toEqual(expected);
  });
});
