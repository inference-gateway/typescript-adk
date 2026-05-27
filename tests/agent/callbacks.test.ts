import { describe, expect, it } from 'vitest';
import {
  runAfterAgent,
  runAfterModel,
  runAfterTool,
  runBeforeAgent,
  runBeforeModel,
  runBeforeTool,
  type CallbackContext,
  type Callbacks,
} from '../../src/agent/callbacks.js';
import { NOOP_LOGGER } from '../../src/server/server-builder.js';
import type { Message } from '../../src/types/generated/a2a.js';

function makeContext(): CallbackContext {
  return {
    agentName: 'test-agent',
    invocationId: 'inv-1',
    taskId: 't-1',
    contextId: 'c-1',
    state: {},
    logger: NOOP_LOGGER,
    signal: new AbortController().signal,
  };
}

function agentMessage(text: string): Message {
  return {
    messageId: `m-${text}`,
    role: 'ROLE_AGENT',
    parts: [{ text }],
  };
}

describe('runBeforeAgent', () => {
  it('returns undefined when callbacks are unset', async () => {
    expect(await runBeforeAgent(undefined, makeContext())).toBeUndefined();
    expect(await runBeforeAgent({}, makeContext())).toBeUndefined();
  });

  it('returns the first non-undefined value and skips later callbacks', async () => {
    const order: string[] = [];
    const callbacks: Callbacks = {
      beforeAgent: [
        () => {
          order.push('a');
          return undefined;
        },
        () => {
          order.push('b');
          return agentMessage('b');
        },
        () => {
          order.push('c');
          return agentMessage('c');
        },
      ],
    };
    const result = await runBeforeAgent(callbacks, makeContext());
    expect(order).toEqual(['a', 'b']);
    expect(result?.parts[0]?.text).toBe('b');
  });

  it('supports async callbacks', async () => {
    const callbacks: Callbacks = {
      beforeAgent: [
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return agentMessage('async');
        },
      ],
    };
    const result = await runBeforeAgent(callbacks, makeContext());
    expect(result?.parts[0]?.text).toBe('async');
  });

  it('lets errors propagate', async () => {
    const callbacks: Callbacks = {
      beforeAgent: [
        () => {
          throw new Error('oops');
        },
      ],
    };
    await expect(runBeforeAgent(callbacks, makeContext())).rejects.toThrow(
      'oops'
    );
  });
});

describe('runAfterAgent', () => {
  it('returns undefined when no callback replaces the output', async () => {
    const callbacks: Callbacks = {
      afterAgent: [() => undefined, () => undefined],
    };
    expect(
      await runAfterAgent(callbacks, makeContext(), agentMessage('x'))
    ).toBeUndefined();
  });

  it('chains: each callback sees the previous replacement', async () => {
    const seen: string[] = [];
    const callbacks: Callbacks = {
      afterAgent: [
        (_ctx, m) => {
          seen.push(m.parts[0]?.text ?? '');
          return agentMessage(`${m.parts[0]?.text}-1`);
        },
        (_ctx, m) => {
          seen.push(m.parts[0]?.text ?? '');
          return agentMessage(`${m.parts[0]?.text}-2`);
        },
      ],
    };
    const result = await runAfterAgent(
      callbacks,
      makeContext(),
      agentMessage('seed')
    );
    expect(seen).toEqual(['seed', 'seed-1']);
    expect(result?.parts[0]?.text).toBe('seed-1-2');
  });
});

describe('runBeforeModel', () => {
  it('returns the first non-undefined override', async () => {
    const callbacks: Callbacks = {
      beforeModel: [
        () => undefined,
        () => ({ message: { content: 'cached' } }),
      ],
    };
    const result = await runBeforeModel(callbacks, makeContext(), {
      messages: [],
    });
    expect(result?.message.content).toBe('cached');
  });

  it('returns undefined when no callback short-circuits', async () => {
    const callbacks: Callbacks = {
      beforeModel: [() => undefined],
    };
    expect(
      await runBeforeModel(callbacks, makeContext(), { messages: [] })
    ).toBeUndefined();
  });
});

describe('runAfterModel', () => {
  it('chains responses through each callback', async () => {
    const callbacks: Callbacks = {
      afterModel: [
        (_ctx, r) => ({
          message: { content: `${r.message.content ?? ''}-1` },
        }),
        (_ctx, r) => ({
          message: { content: `${r.message.content ?? ''}-2` },
        }),
      ],
    };
    const result = await runAfterModel(callbacks, makeContext(), {
      message: { content: 'seed' },
    });
    expect(result?.message.content).toBe('seed-1-2');
  });
});

describe('runBeforeTool', () => {
  it('returns the first non-undefined override', async () => {
    const callbacks: Callbacks = {
      beforeTool: [() => undefined, () => 'cached', () => 'never'],
    };
    const result = await runBeforeTool(callbacks, makeContext(), {
      id: 'a',
      name: 't',
      arguments: '{}',
    });
    expect(result).toBe('cached');
  });
});

describe('runAfterTool', () => {
  it('chains results through each callback', async () => {
    const callbacks: Callbacks = {
      afterTool: [(_ctx, _call, r) => `${r}-1`, (_ctx, _call, r) => `${r}-2`],
    };
    const result = await runAfterTool(
      callbacks,
      makeContext(),
      { id: 'a', name: 't', arguments: '{}' },
      'seed'
    );
    expect(result).toBe('seed-1-2');
  });

  it('returns undefined when no callback replaces the result', async () => {
    const callbacks: Callbacks = {
      afterTool: [() => undefined, () => undefined],
    };
    const result = await runAfterTool(
      callbacks,
      makeContext(),
      { id: 'a', name: 't', arguments: '{}' },
      'seed'
    );
    expect(result).toBeUndefined();
  });
});
