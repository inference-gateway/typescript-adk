import { describe, expect, it, vi } from 'vitest';
import { createTask, TASK_STATE } from '../../src/agent/task.js';
import {
  DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS,
  DEFAULT_MAX_CONVERSATION_HISTORY,
  DefaultBackgroundTaskHandler,
  INPUT_REQUIRED_TOOL,
  MAX_CHAT_COMPLETION_ITERATIONS_ENV,
  UsageTracker,
  type AssistantMessage,
  type CompletionResult,
  type CreateCompletionOptions,
  type LLMClient,
  type ToolBox,
  type ToolCall,
  type ToolDefinition,
} from '../../src/server/default-background-task-handler.js';
import type {
  BackgroundTaskContext,
  Logger,
} from '../../src/server/server-builder.js';
import type { Message } from '../../src/types/generated/a2a.js';

interface RecordedCall {
  readonly messages: CreateCompletionOptions['messages'];
  readonly tools: readonly ToolDefinition[] | undefined;
}

function buildContext(
  options: {
    readonly userText?: string;
    readonly extraMessages?: readonly Message[];
  } = {}
): BackgroundTaskContext {
  const message: Message = {
    messageId: 'm-1',
    role: 'ROLE_USER',
    parts: [{ text: options.userText ?? 'hello' }],
  };
  const task = createTask({
    id: 't-1',
    contextId: 'c-1',
    messages: [message, ...(options.extraMessages ?? [])],
  });
  const controller = new AbortController();
  return {
    task,
    message,
    signal: controller.signal,
  };
}

function silentLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * Scriptable LLM client - each call returns the next queued completion.
 * Records every set of messages and tools the handler forwarded so tests can
 * assert on iteration shape and history truncation.
 */
function scriptedClient(responses: readonly CompletionResult[]): {
  readonly client: LLMClient;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const client: LLMClient = {
    createCompletion: async (opts: CreateCompletionOptions) => {
      calls.push({ messages: opts.messages, tools: opts.tools });
      const response = responses[index];
      index++;
      if (response === undefined) {
        throw new Error(
          `scriptedClient exhausted: expected at most ${responses.length} calls`
        );
      }
      return response;
    },
  };
  return { client, calls };
}

function assistantText(
  content: string,
  usage?: CompletionResult['usage']
): CompletionResult {
  const result: CompletionResult = {
    message: { content },
    ...(usage !== undefined ? { usage } : {}),
  };
  return result;
}

function assistantToolCalls(
  toolCalls: readonly ToolCall[],
  usage?: CompletionResult['usage']
): CompletionResult {
  const assistant: AssistantMessage = { toolCalls };
  return {
    message: assistant,
    ...(usage !== undefined ? { usage } : {}),
  };
}

describe('DefaultBackgroundTaskHandler constructor', () => {
  it('resolves the iteration cap from MAX_CHAT_COMPLETION_ITERATIONS env var', () => {
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: scriptedClient([]).client,
      env: { [MAX_CHAT_COMPLETION_ITERATIONS_ENV]: '7' },
    });
    expect(handler.getMaxIterations()).toBe(7);
  });

  it('falls back to the default iteration cap when env var is unset', () => {
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: scriptedClient([]).client,
      env: {},
    });
    expect(handler.getMaxIterations()).toBe(
      DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS
    );
  });

  it('falls back to the default when env var is non-numeric or non-positive', () => {
    for (const raw of ['', 'nope', '0', '-3']) {
      const handler = new DefaultBackgroundTaskHandler({
        llmClient: scriptedClient([]).client,
        env: { [MAX_CHAT_COMPLETION_ITERATIONS_ENV]: raw },
      });
      expect(handler.getMaxIterations()).toBe(
        DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS
      );
    }
  });

  it('lets constructor override beat env var', () => {
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: scriptedClient([]).client,
      env: { [MAX_CHAT_COMPLETION_ITERATIONS_ENV]: '99' },
      maxIterations: 3,
    });
    expect(handler.getMaxIterations()).toBe(3);
  });

  it('defaults conversation-history budget to 20', () => {
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: scriptedClient([]).client,
    });
    expect(handler.getMaxConversationHistory()).toBe(
      DEFAULT_MAX_CONVERSATION_HISTORY
    );
  });

  it('rejects non-positive maxIterations / maxConversationHistory', () => {
    expect(
      () =>
        new DefaultBackgroundTaskHandler({
          llmClient: scriptedClient([]).client,
          maxIterations: 0,
        })
    ).toThrow(RangeError);
    expect(
      () =>
        new DefaultBackgroundTaskHandler({
          llmClient: scriptedClient([]).client,
          maxConversationHistory: -1,
        })
    ).toThrow(RangeError);
  });

  it('rejects construction without an llmClient', () => {
    expect(
      () =>
        new DefaultBackgroundTaskHandler({
          llmClient: undefined as unknown as LLMClient,
        })
    ).toThrow(TypeError);
  });
});

describe('DefaultBackgroundTaskHandler happy path', () => {
  it('moves PENDING -> IN_PROGRESS -> COMPLETED on a tool-free completion', async () => {
    const { client, calls } = scriptedClient([assistantText('hi there')]);
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      logger: silentLogger(),
    });
    const ctx = buildContext({ userText: 'hi' });
    const result = await handler.handle(ctx);

    expect(result.state).toBe(TASK_STATE.COMPLETED);
    expect(result.completedAt).toBeDefined();
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]?.role).toBe('ROLE_AGENT');
    expect(result.messages[1]?.parts[0]?.text).toBe('hi there');
    expect(result.status.message?.parts[0]?.text).toBe('hi there');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(calls[0]?.tools).toBeUndefined();
  });

  it('prepends the system prompt and excludes it from the truncation budget', async () => {
    const { client, calls } = scriptedClient([assistantText('done')]);
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      systemPrompt: 'You are a test agent.',
      maxConversationHistory: 1,
    });
    const result = await handler.handle(buildContext());
    expect(result.state).toBe(TASK_STATE.COMPLETED);
    expect(calls[0]?.messages).toEqual([
      { role: 'system', content: 'You are a test agent.' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('dispatches a tool call, feeds the result back, and completes on the second turn', async () => {
    const { client, calls } = scriptedClient([
      assistantToolCalls([
        { id: 'call-1', name: 'lookup', arguments: '{"q":"ts"}' },
      ]),
      assistantText('found 42 results'),
    ]);
    const executed: Array<{ name: string; args: string }> = [];
    const toolBox: ToolBox = {
      list: () => [
        {
          name: 'lookup',
          description: 'Look something up',
          parameters: {},
        },
      ],
      execute: async (name, args) => {
        executed.push({ name, args });
        return '42';
      },
    };
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      toolBox,
    });
    const result = await handler.handle(buildContext());

    expect(result.state).toBe(TASK_STATE.COMPLETED);
    expect(executed).toEqual([{ name: 'lookup', args: '{"q":"ts"}' }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        toolCalls: [{ id: 'call-1', name: 'lookup', arguments: '{"q":"ts"}' }],
      },
      { role: 'tool', toolCallId: 'call-1', content: '42' },
    ]);
    expect(calls[1]?.tools).toEqual([
      { name: 'lookup', description: 'Look something up', parameters: {} },
    ]);
  });

  it('returns existing terminal task unchanged', async () => {
    const { client } = scriptedClient([]);
    const handler = new DefaultBackgroundTaskHandler({ llmClient: client });
    const ctx = buildContext();
    const terminal = {
      ...ctx.task,
      state: TASK_STATE.COMPLETED,
      status: { ...ctx.task.status, state: TASK_STATE.COMPLETED },
    };
    const result = await handler.handle({ ...ctx, task: terminal });
    expect(result).toBe(terminal);
  });
});

describe('DefaultBackgroundTaskHandler iteration cap', () => {
  it('fails the task when the LLM keeps requesting tool calls past the cap', async () => {
    const responses: CompletionResult[] = [];
    for (let i = 0; i < 5; i++) {
      responses.push(
        assistantToolCalls([{ id: `call-${i}`, name: 'noop', arguments: '{}' }])
      );
    }
    const { client, calls } = scriptedClient(responses);
    const toolBox: ToolBox = {
      list: () => [{ name: 'noop', description: 'noop', parameters: {} }],
      execute: async () => 'ok',
    };
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      toolBox,
      maxIterations: 3,
    });

    const result = await handler.handle(buildContext());

    expect(result.state).toBe(TASK_STATE.FAILED);
    expect(result.status.message?.parts[0]?.text).toMatch(
      /Iteration cap reached \(3\)/
    );
    expect(calls).toHaveLength(3);
  });

  it('counts iterations only - tool calls within one iteration do not double-count', async () => {
    const { client } = scriptedClient([
      assistantToolCalls([
        { id: 'a', name: 't', arguments: '{}' },
        { id: 'b', name: 't', arguments: '{}' },
      ]),
      assistantText('done'),
    ]);
    const toolBox: ToolBox = {
      list: () => [{ name: 't', description: 't', parameters: {} }],
      execute: async () => 'ok',
    };
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      toolBox,
      maxIterations: 2,
    });
    const result = await handler.handle(buildContext());
    expect(result.state).toBe(TASK_STATE.COMPLETED);
  });
});

describe('DefaultBackgroundTaskHandler history truncation', () => {
  it('truncates the user/assistant tail to maxConversationHistory each iteration', async () => {
    const extras: Message[] = [];
    for (let i = 0; i < 5; i++) {
      extras.push({
        messageId: `u-${i}`,
        role: 'ROLE_USER',
        parts: [{ text: `prompt-${i}` }],
      });
    }
    const { client, calls } = scriptedClient([assistantText('done')]);
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      maxConversationHistory: 2,
    });
    await handler.handle(
      buildContext({ userText: 'oldest', extraMessages: extras })
    );

    // 6 user messages total; budget is 2, so only the last 2 are sent.
    expect(calls[0]?.messages).toHaveLength(2);
    expect(calls[0]?.messages[0]).toEqual({
      role: 'user',
      content: 'prompt-3',
    });
    expect(calls[0]?.messages[1]).toEqual({
      role: 'user',
      content: 'prompt-4',
    });
  });

  it('keeps the system prompt outside the truncation budget', async () => {
    const extras: Message[] = [];
    for (let i = 0; i < 5; i++) {
      extras.push({
        messageId: `u-${i}`,
        role: 'ROLE_USER',
        parts: [{ text: `prompt-${i}` }],
      });
    }
    const { client, calls } = scriptedClient([assistantText('done')]);
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      maxConversationHistory: 2,
      systemPrompt: 'sys',
    });
    await handler.handle(buildContext({ extraMessages: extras }));
    expect(calls[0]?.messages).toHaveLength(3);
    expect(calls[0]?.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('truncates the running conversation (user + tool messages) across iterations', async () => {
    const { client, calls } = scriptedClient([
      assistantToolCalls([{ id: 'call-1', name: 't', arguments: '{}' }]),
      assistantToolCalls([{ id: 'call-2', name: 't', arguments: '{}' }]),
      assistantText('done'),
    ]);
    const toolBox: ToolBox = {
      list: () => [{ name: 't', description: 't', parameters: {} }],
      execute: async () => 'result',
    };
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      toolBox,
      maxConversationHistory: 2,
    });
    await handler.handle(buildContext());

    // 3rd iteration: conversation accumulated [user, asst(t), tool, asst(t), tool].
    // Budget 2 means only the trailing two messages reach the model.
    expect(calls[2]?.messages).toHaveLength(2);
    expect(calls[2]?.messages[0]?.role).toBe('assistant');
    expect(calls[2]?.messages[1]?.role).toBe('tool');
  });
});

describe('DefaultBackgroundTaskHandler input_required interception', () => {
  it('transitions to INPUT_REQUIRED when the LLM calls input_required', async () => {
    const promptArgs = JSON.stringify({ message: 'What size?' });
    const { client, calls } = scriptedClient([
      assistantToolCalls([
        { id: 'q-1', name: INPUT_REQUIRED_TOOL, arguments: promptArgs },
      ]),
    ]);
    const executed = vi.fn().mockResolvedValue('should-not-run');
    const toolBox: ToolBox = {
      list: () => [
        {
          name: INPUT_REQUIRED_TOOL,
          description: 'Pause and wait for user input.',
          parameters: {},
        },
      ],
      execute: executed,
    };
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      toolBox,
    });

    const result = await handler.handle(buildContext());

    expect(result.state).toBe(TASK_STATE.INPUT_REQUIRED);
    expect(result.status.message?.parts[0]?.text).toBe('What size?');
    expect(result.messages[result.messages.length - 1]?.parts[0]?.text).toBe(
      'What size?'
    );
    expect(executed).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('falls back to a generic prompt when args are missing or malformed', async () => {
    const { client } = scriptedClient([
      assistantToolCalls([
        { id: 'q-1', name: INPUT_REQUIRED_TOOL, arguments: '' },
      ]),
    ]);
    const handler = new DefaultBackgroundTaskHandler({ llmClient: client });
    const result = await handler.handle(buildContext());
    expect(result.state).toBe(TASK_STATE.INPUT_REQUIRED);
    expect(result.status.message?.parts[0]?.text).toBe(
      'Additional input required.'
    );
  });
});

describe('DefaultBackgroundTaskHandler usage metadata', () => {
  it('omits metadata by default', async () => {
    const { client } = scriptedClient([
      assistantText('done', { promptTokens: 5, completionTokens: 7 }),
    ]);
    const handler = new DefaultBackgroundTaskHandler({ llmClient: client });
    const result = await handler.handle(buildContext());
    expect(result.state).toBe(TASK_STATE.COMPLETED);
    expect(result.metadata).toBeUndefined();
  });

  it('attaches token usage and execution stats when enabled', async () => {
    const { client } = scriptedClient([
      assistantToolCalls([{ id: 'a', name: 't', arguments: '{}' }], {
        promptTokens: 5,
        completionTokens: 5,
      }),
      assistantText('done', {
        promptTokens: 3,
        completionTokens: 8,
        totalTokens: 11,
      }),
    ]);
    const toolBox: ToolBox = {
      list: () => [{ name: 't', description: 't', parameters: {} }],
      execute: async () => 'ok',
    };
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      toolBox,
    });
    handler.setEnableUsageMetadata(true);
    expect(handler.isUsageMetadataEnabled()).toBe(true);

    const result = await handler.handle(buildContext());
    expect(result.state).toBe(TASK_STATE.COMPLETED);
    const metadata = result.metadata as Record<string, unknown> | undefined;
    expect(metadata).toBeDefined();
    expect(metadata?.['usage']).toEqual({
      prompt_tokens: 8,
      completion_tokens: 13,
      total_tokens: 21,
    });
    expect(metadata?.['execution_stats']).toEqual({
      iterations: 2,
      tool_calls: 1,
      failed_tools: 0,
    });
  });

  it('counts failed tools when execute throws', async () => {
    const { client } = scriptedClient([
      assistantToolCalls([{ id: 'a', name: 'broken', arguments: '{}' }]),
      assistantText('giving up'),
    ]);
    const toolBox: ToolBox = {
      list: () => [
        { name: 'broken', description: 'always fails', parameters: {} },
      ],
      execute: async () => {
        throw new Error('boom');
      },
    };
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      toolBox,
    });
    handler.setEnableUsageMetadata(true);

    const result = await handler.handle(buildContext());
    const metadata = result.metadata as Record<string, unknown> | undefined;
    expect(metadata?.['execution_stats']).toEqual({
      iterations: 2,
      tool_calls: 1,
      failed_tools: 1,
    });
  });
});

describe('DefaultBackgroundTaskHandler error handling', () => {
  it('transitions to FAILED when the LLM throws', async () => {
    const client: LLMClient = {
      createCompletion: async () => {
        throw new Error('upstream blew up');
      },
    };
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      logger: silentLogger(),
    });
    const result = await handler.handle(buildContext());
    expect(result.state).toBe(TASK_STATE.FAILED);
    expect(result.status.message?.parts[0]?.text).toBe('upstream blew up');
  });

  it('transitions to CANCELLED when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = { ...buildContext(), signal: controller.signal };
    const { client } = scriptedClient([assistantText('never')]);
    const handler = new DefaultBackgroundTaskHandler({ llmClient: client });
    const result = await handler.handle(ctx);
    expect(result.state).toBe(TASK_STATE.CANCELLED);
  });

  it('reports tool errors back to the model and continues the loop', async () => {
    const { client, calls } = scriptedClient([
      assistantToolCalls([{ id: 'a', name: 'broken', arguments: '{}' }]),
      assistantText('moving on'),
    ]);
    const toolBox: ToolBox = {
      list: () => [
        { name: 'broken', description: 'always fails', parameters: {} },
      ],
      execute: async () => {
        throw new Error('boom');
      },
    };
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      toolBox,
    });
    const result = await handler.handle(buildContext());
    expect(result.state).toBe(TASK_STATE.COMPLETED);
    expect(calls[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'a',
      content: 'Error executing tool "broken": boom',
    });
  });

  it('falls back gracefully when the LLM emits a tool call but no tool box is registered', async () => {
    const { client, calls } = scriptedClient([
      assistantToolCalls([{ id: 'a', name: 'do_thing', arguments: '{}' }]),
      assistantText('done anyway'),
    ]);
    const handler = new DefaultBackgroundTaskHandler({ llmClient: client });
    const result = await handler.handle(buildContext());
    expect(result.state).toBe(TASK_STATE.COMPLETED);
    expect(calls[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'a',
      content: 'Tool "do_thing" is not available: no toolBox configured.',
    });
  });
});

describe('DefaultBackgroundTaskHandler.asHandler', () => {
  it('returns a BackgroundTaskHandler-compatible function', async () => {
    const { client } = scriptedClient([assistantText('hi')]);
    const handler = new DefaultBackgroundTaskHandler({ llmClient: client });
    const callable = handler.asHandler();
    const result = await callable(buildContext());
    expect(result.state).toBe(TASK_STATE.COMPLETED);
  });
});

describe('UsageTracker', () => {
  it('starts with no usage and gains usage as it accumulates', () => {
    const tracker = new UsageTracker();
    expect(tracker.hasUsage()).toBe(false);

    tracker.incrementIteration();
    expect(tracker.hasUsage()).toBe(true);

    tracker.addUsage({ promptTokens: 4, completionTokens: 6 });
    const metadata = tracker.getMetadata();
    expect(metadata['usage']).toEqual({
      prompt_tokens: 4,
      completion_tokens: 6,
      total_tokens: 10,
    });
    expect(metadata['execution_stats']).toEqual({
      iterations: 1,
      tool_calls: 0,
      failed_tools: 0,
    });
  });

  it('honors an explicit totalTokens override from the LLM', () => {
    const tracker = new UsageTracker();
    tracker.addUsage({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 99,
    });
    expect(tracker.getMetadata()['usage']).toEqual({
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 99,
    });
  });
});
