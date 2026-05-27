import { describe, expect, it, vi } from 'vitest';
import { createTask, TASK_STATE } from '../../src/agent/task.js';
import {
  DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS,
  DEFAULT_MAX_CONVERSATION_HISTORY,
  DefaultStreamingTaskHandler,
  INPUT_REQUIRED_TOOL,
  MAX_CHAT_COMPLETION_ITERATIONS_ENV,
  type AssistantMessage,
  type CompletionResult,
  type CreateCompletionOptions,
  type LLMClient,
  type ToolBox,
  type ToolCall,
  type ToolDefinition,
} from '../../src/server/index.js';
import type {
  StreamingExecutorContext,
  StreamingTaskEvent,
} from '../../src/server/message-stream.js';
import type { Logger } from '../../src/server/server-builder.js';
import type { Message } from '../../src/types/generated/a2a.js';

interface RecordedCall {
  readonly messages: CreateCompletionOptions['messages'];
  readonly tools: readonly ToolDefinition[] | undefined;
}

function buildContext(
  options: {
    readonly userText?: string;
    readonly extraMessages?: readonly Message[];
    readonly signal?: AbortSignal;
  } = {}
): StreamingExecutorContext {
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
  return {
    task,
    message,
    signal: options.signal ?? new AbortController().signal,
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
  return {
    message: { content },
    ...(usage !== undefined ? { usage } : {}),
  };
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

async function drain(
  iterable: AsyncIterable<StreamingTaskEvent>
): Promise<StreamingTaskEvent[]> {
  const events: StreamingTaskEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe('DefaultStreamingTaskHandler constructor', () => {
  it('resolves the iteration cap from MAX_CHAT_COMPLETION_ITERATIONS env var', () => {
    const handler = new DefaultStreamingTaskHandler({
      llmClient: scriptedClient([]).client,
      env: { [MAX_CHAT_COMPLETION_ITERATIONS_ENV]: '7' },
    });
    expect(handler.getMaxIterations()).toBe(7);
  });

  it('falls back to the default iteration cap when env var is unset', () => {
    const handler = new DefaultStreamingTaskHandler({
      llmClient: scriptedClient([]).client,
      env: {},
    });
    expect(handler.getMaxIterations()).toBe(
      DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS
    );
  });

  it('lets constructor override beat env var', () => {
    const handler = new DefaultStreamingTaskHandler({
      llmClient: scriptedClient([]).client,
      env: { [MAX_CHAT_COMPLETION_ITERATIONS_ENV]: '99' },
      maxIterations: 3,
    });
    expect(handler.getMaxIterations()).toBe(3);
  });

  it('defaults conversation-history budget', () => {
    const handler = new DefaultStreamingTaskHandler({
      llmClient: scriptedClient([]).client,
    });
    expect(handler.getMaxConversationHistory()).toBe(
      DEFAULT_MAX_CONVERSATION_HISTORY
    );
  });

  it('rejects non-positive maxIterations / maxConversationHistory', () => {
    expect(
      () =>
        new DefaultStreamingTaskHandler({
          llmClient: scriptedClient([]).client,
          maxIterations: 0,
        })
    ).toThrow(RangeError);
    expect(
      () =>
        new DefaultStreamingTaskHandler({
          llmClient: scriptedClient([]).client,
          maxConversationHistory: -1,
        })
    ).toThrow(RangeError);
  });

  it('rejects construction without an llmClient', () => {
    expect(
      () =>
        new DefaultStreamingTaskHandler({
          llmClient: undefined as unknown as LLMClient,
        })
    ).toThrow(TypeError);
  });
});

describe('DefaultStreamingTaskHandler happy path', () => {
  it('emits delta + iterationCompleted for a tool-free completion', async () => {
    const { client, calls } = scriptedClient([assistantText('hi there')]);
    const handler = new DefaultStreamingTaskHandler({
      llmClient: client,
      logger: silentLogger(),
    });
    const events = await drain(
      handler.handle(buildContext({ userText: 'hi' }))
    );

    expect(events).toHaveLength(2);
    const delta = events[0];
    const iteration = events[1];
    expect(delta?.type).toBe('delta');
    expect(iteration?.type).toBe('iterationCompleted');
    if (delta?.type === 'delta') {
      expect(delta.message.parts[0]?.text).toBe('hi there');
      expect(delta.message.role).toBe('ROLE_AGENT');
      expect(delta.message.taskId).toBe('t-1');
      expect(delta.message.contextId).toBe('c-1');
    }
    if (iteration?.type === 'iterationCompleted') {
      expect(iteration.iteration).toBe(1);
      expect(iteration.message?.parts[0]?.text).toBe('hi there');
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(calls[0]?.tools).toBeUndefined();
  });

  it('does not emit a delta when assistant content is empty', async () => {
    const { client } = scriptedClient([assistantText('')]);
    const handler = new DefaultStreamingTaskHandler({ llmClient: client });
    const events = await drain(handler.handle(buildContext()));
    const types = events.map((e) => e.type);
    expect(types).toEqual(['iterationCompleted']);
  });

  it('prepends the system prompt and excludes it from the truncation budget', async () => {
    const { client, calls } = scriptedClient([assistantText('done')]);
    const handler = new DefaultStreamingTaskHandler({
      llmClient: client,
      systemPrompt: 'You are a test agent.',
      maxConversationHistory: 1,
    });
    await drain(handler.handle(buildContext()));
    expect(calls[0]?.messages).toEqual([
      { role: 'system', content: 'You are a test agent.' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('dispatches a tool call, emits started/completed/result, feeds result back, completes', async () => {
    const { client, calls } = scriptedClient([
      assistantToolCalls([
        { id: 'call-1', name: 'lookup', arguments: '{"q":"ts"}' },
      ]),
      assistantText('found 42 results'),
    ]);
    const executed: Array<{ name: string; args: string }> = [];
    const toolBox: ToolBox = {
      list: () => [
        { name: 'lookup', description: 'Look something up', parameters: {} },
      ],
      execute: async (name, args) => {
        executed.push({ name, args });
        return '42';
      },
    };
    const handler = new DefaultStreamingTaskHandler({
      llmClient: client,
      toolBox,
    });
    const events = await drain(handler.handle(buildContext()));

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'toolStarted',
      'toolCompleted',
      'toolResult',
      'iterationCompleted',
      'delta',
      'iterationCompleted',
    ]);

    const started = events[0];
    const completed = events[1];
    const tooled = events[2];
    if (started?.type === 'toolStarted') {
      expect(started.toolCallId).toBe('call-1');
      expect(started.toolName).toBe('lookup');
      expect(started.arguments).toBe('{"q":"ts"}');
    }
    if (completed?.type === 'toolCompleted') {
      expect(completed.toolCallId).toBe('call-1');
    }
    if (tooled?.type === 'toolResult') {
      expect(tooled.result).toBe('42');
      expect(tooled.isError).toBe(false);
    }

    expect(executed).toEqual([{ name: 'lookup', args: '{"q":"ts"}' }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'call-1',
      content: '42',
    });
  });

  it('yields no events when the task is already terminal', async () => {
    const { client } = scriptedClient([]);
    const handler = new DefaultStreamingTaskHandler({ llmClient: client });
    const ctx = buildContext();
    const terminal = {
      ...ctx.task,
      state: TASK_STATE.COMPLETED,
      status: { ...ctx.task.status, state: TASK_STATE.COMPLETED },
    };
    const events = await drain(
      handler.handle({ ...ctx, task: terminal, signal: ctx.signal })
    );
    expect(events).toEqual([]);
  });
});

describe('DefaultStreamingTaskHandler input_required interception', () => {
  it('emits toolStarted, toolCompleted, inputRequiredNotice, iterationCompleted, inputRequired and ends', async () => {
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
    const handler = new DefaultStreamingTaskHandler({
      llmClient: client,
      toolBox,
    });

    const events = await drain(handler.handle(buildContext()));

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'toolStarted',
      'toolCompleted',
      'inputRequiredNotice',
      'iterationCompleted',
      'inputRequired',
    ]);

    const notice = events[2];
    const ir = events[4];
    if (notice?.type === 'inputRequiredNotice') {
      expect(notice.message.parts[0]?.text).toBe('What size?');
      expect(notice.message.role).toBe('ROLE_AGENT');
    }
    if (ir?.type === 'inputRequired') {
      expect(ir.message.parts[0]?.text).toBe('What size?');
    }

    expect(executed).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('falls back to a generic prompt when args are missing or malformed', async () => {
    const { client } = scriptedClient([
      assistantToolCalls([
        { id: 'q-1', name: INPUT_REQUIRED_TOOL, arguments: '' },
      ]),
    ]);
    const handler = new DefaultStreamingTaskHandler({ llmClient: client });
    const events = await drain(handler.handle(buildContext()));
    const notice = events.find((e) => e.type === 'inputRequiredNotice');
    expect(notice).toBeDefined();
    if (notice?.type === 'inputRequiredNotice') {
      expect(notice.message.parts[0]?.text).toBe('Additional input required.');
    }
  });
});

describe('DefaultStreamingTaskHandler iteration cap', () => {
  it('yields a terminal statusChanged(FAILED) when the LLM keeps requesting tool calls past the cap', async () => {
    const responses: CompletionResult[] = [];
    for (let i = 0; i < 5; i++) {
      responses.push(
        assistantToolCalls([{ id: `call-${i}`, name: 'noop', arguments: '{}' }])
      );
    }
    const { client } = scriptedClient(responses);
    const toolBox: ToolBox = {
      list: () => [{ name: 'noop', description: 'noop', parameters: {} }],
      execute: async () => 'ok',
    };
    const handler = new DefaultStreamingTaskHandler({
      llmClient: client,
      toolBox,
      maxIterations: 3,
    });

    const events = await drain(handler.handle(buildContext()));
    const last = events[events.length - 1];
    expect(last?.type).toBe('statusChanged');
    if (last?.type === 'statusChanged') {
      expect(last.state).toBe(TASK_STATE.FAILED);
      expect(last.message?.parts[0]?.text).toMatch(
        /Iteration cap reached \(3\)/
      );
    }
  });
});

describe('DefaultStreamingTaskHandler cancellation', () => {
  it('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = buildContext({ signal: controller.signal });
    const { client } = scriptedClient([assistantText('never')]);
    const handler = new DefaultStreamingTaskHandler({ llmClient: client });
    const events = await drain(handler.handle(ctx));
    expect(events).toEqual([]);
  });

  it('stops yielding after an abort mid-iteration', async () => {
    const controller = new AbortController();
    const { client } = scriptedClient([
      assistantToolCalls([
        { id: 'a', name: 't', arguments: '{}' },
        { id: 'b', name: 't', arguments: '{}' },
      ]),
    ]);
    const toolBox: ToolBox = {
      list: () => [{ name: 't', description: 't', parameters: {} }],
      execute: async () => {
        controller.abort();
        return 'aborted-during';
      },
    };
    const handler = new DefaultStreamingTaskHandler({
      llmClient: client,
      toolBox,
    });
    const events = await drain(
      handler.handle(buildContext({ signal: controller.signal }))
    );
    // Should have yielded toolStarted for the first call before the executor
    // body aborts; afterwards generator returns and the second call is skipped.
    expect(events[0]?.type).toBe('toolStarted');
    // No iterationCompleted because we bailed out of the loop.
    expect(events.find((e) => e.type === 'iterationCompleted')).toBeUndefined();
  });
});

describe('DefaultStreamingTaskHandler tool failure handling', () => {
  it('emits toolFailed + toolResult(isError) when toolbox throws, then continues', async () => {
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
    const handler = new DefaultStreamingTaskHandler({
      llmClient: client,
      toolBox,
    });
    const events = await drain(handler.handle(buildContext()));
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'toolStarted',
      'toolFailed',
      'toolResult',
      'iterationCompleted',
      'delta',
      'iterationCompleted',
    ]);
    const failed = events[1];
    const tooled = events[2];
    if (failed?.type === 'toolFailed') {
      expect(failed.error).toMatch(/Error executing tool "broken": boom/);
    }
    if (tooled?.type === 'toolResult') {
      expect(tooled.isError).toBe(true);
    }
    expect(calls[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'a',
      content: 'Error executing tool "broken": boom',
    });
  });

  it('synthesises a toolFailed when assistant emits tool calls but no toolBox configured', async () => {
    const { client, calls } = scriptedClient([
      assistantToolCalls([{ id: 'a', name: 'do_thing', arguments: '{}' }]),
      assistantText('done anyway'),
    ]);
    const handler = new DefaultStreamingTaskHandler({ llmClient: client });
    const events = await drain(handler.handle(buildContext()));
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'toolStarted',
      'toolFailed',
      'toolResult',
      'iterationCompleted',
      'delta',
      'iterationCompleted',
    ]);
    expect(calls[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'a',
      content: 'Tool "do_thing" is not available: no toolBox configured.',
    });
  });
});

describe('DefaultStreamingTaskHandler error propagation', () => {
  it('rethrows LLM errors so the streaming pipeline can transition to FAILED', async () => {
    const client: LLMClient = {
      createCompletion: async () => {
        throw new Error('upstream blew up');
      },
    };
    const handler = new DefaultStreamingTaskHandler({
      llmClient: client,
      logger: silentLogger(),
    });
    await expect(drain(handler.handle(buildContext()))).rejects.toThrow(
      /upstream blew up/
    );
  });

  it('swallows LLM error when signal is already aborted', async () => {
    const controller = new AbortController();
    const client: LLMClient = {
      createCompletion: async () => {
        controller.abort();
        throw new Error('aborted upstream');
      },
    };
    const handler = new DefaultStreamingTaskHandler({ llmClient: client });
    const events = await drain(
      handler.handle(buildContext({ signal: controller.signal }))
    );
    expect(events).toEqual([]);
  });
});

describe('DefaultStreamingTaskHandler.asHandler', () => {
  it('returns a StreamingTaskExecutor-compatible function', async () => {
    const { client } = scriptedClient([assistantText('hi')]);
    const handler = new DefaultStreamingTaskHandler({ llmClient: client });
    const callable = handler.asHandler();
    const events: StreamingTaskEvent[] = [];
    for await (const event of callable(buildContext())) {
      events.push(event);
    }
    expect(events.map((e) => e.type)).toEqual(['delta', 'iterationCompleted']);
  });
});

describe('DefaultStreamingTaskHandler usage metadata', () => {
  it('is off by default and toggles via setEnableUsageMetadata', () => {
    const handler = new DefaultStreamingTaskHandler({
      llmClient: scriptedClient([]).client,
    });
    expect(handler.isUsageMetadataEnabled()).toBe(false);
    handler.setEnableUsageMetadata(true);
    expect(handler.isUsageMetadataEnabled()).toBe(true);
  });
});
