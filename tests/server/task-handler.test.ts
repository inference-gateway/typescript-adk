import { describe, expect, it, vi } from 'vitest';
import {
  TASK_STATE,
  transitionTask,
  type ManagedTask,
} from '../../src/agent/task.js';
import {
  A2AServer,
  A2AServerBuilder,
  AGENT_EVENT_TYPE,
  BaseStreamableTaskHandler,
  BaseTaskHandler,
  MESSAGE_SEND_METHOD,
  MESSAGE_STREAM_METHOD,
  createCloudEvent,
  type CloudEvent,
  type OpenAICompatibleAgent,
  type StreamableTaskHandler,
  type TaskHandler,
  type TaskHandlerContext,
} from '../../src/server/index.js';
import type { AgentCard, Message } from '../../src/types/index.js';

function backgroundCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'background-agent',
    description: 'Agent under test',
    version: '0.0.1',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: {},
    skills: [
      {
        id: 'echo',
        name: 'Echo',
        description: 'Echoes input back to the caller.',
        tags: [],
      },
    ],
    ...overrides,
  };
}

function streamingCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return backgroundCard({
    name: 'streaming-agent',
    capabilities: { streaming: true },
    ...overrides,
  });
}

const decoder = new TextDecoder();

async function drainFrames(
  stream: ReadableStream<Uint8Array>
): Promise<Record<string, unknown>[]> {
  const reader = stream.getReader();
  let buffer = '';
  const frames: Record<string, unknown>[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx < 0) {
          break;
        }
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!raw.startsWith('data: ')) {
          continue;
        }
        frames.push(
          JSON.parse(raw.slice('data: '.length)) as Record<string, unknown>
        );
      }
    }
  } finally {
    reader.releaseLock();
  }
  return frames;
}

describe('BaseTaskHandler', () => {
  it('returns undefined from getAgent before any setAgent call', () => {
    class NoopHandler extends BaseTaskHandler {
      async handleTask(): Promise<ManagedTask> {
        throw new Error('unused');
      }
    }
    const handler = new NoopHandler();
    expect(handler.getAgent()).toBeUndefined();
  });

  it('round-trips the agent through setAgent / getAgent', () => {
    class NoopHandler extends BaseTaskHandler {
      async handleTask(): Promise<ManagedTask> {
        throw new Error('unused');
      }
    }
    const agent: OpenAICompatibleAgent = { id: 'gpt-4o-mini' };
    const handler = new NoopHandler();
    handler.setAgent(agent);
    expect(handler.getAgent()).toBe(agent);
  });
});

describe('BaseStreamableTaskHandler', () => {
  it('round-trips the agent through setAgent / getAgent', () => {
    class NoopHandler extends BaseStreamableTaskHandler {
      async *handleStreamingTask(): AsyncIterable<CloudEvent> {
        // never yields
      }
    }
    const agent: OpenAICompatibleAgent = { id: 'gpt-4o' };
    const handler = new NoopHandler();
    handler.setAgent(agent);
    expect(handler.getAgent()).toBe(agent);
  });
});

describe('A2AServerBuilder.withTaskHandler', () => {
  it('stores the handler and wires it as the background handler', () => {
    const handler: TaskHandler = {
      handleTask: vi.fn(),
      setAgent: vi.fn(),
      getAgent: vi.fn(() => undefined),
    };
    const builder = new A2AServerBuilder({})
      .withAgentCard(backgroundCard())
      .withTaskHandler(handler);
    expect(builder.getTaskHandler()).toBe(handler);
    expect(builder.getBackgroundTaskHandler()).toBeDefined();
  });

  it('injects an agent via setAgent if one was already registered', () => {
    const setAgentSpy = vi.fn();
    const handler: TaskHandler = {
      handleTask: vi.fn(),
      setAgent: setAgentSpy,
      getAgent: vi.fn(() => undefined),
    };
    const agent: OpenAICompatibleAgent = { id: 'gpt-4' };
    new A2AServerBuilder({})
      .withAgent(agent)
      .withAgentCard(backgroundCard())
      .withTaskHandler(handler);
    expect(setAgentSpy).toHaveBeenCalledWith(agent);
  });

  it('forwards a later withAgent call to a previously registered handler', () => {
    const setAgentSpy = vi.fn();
    const handler: TaskHandler = {
      handleTask: vi.fn(),
      setAgent: setAgentSpy,
      getAgent: vi.fn(() => undefined),
    };
    const agent: OpenAICompatibleAgent = { id: 'gpt-4' };
    new A2AServerBuilder({})
      .withAgentCard(backgroundCard())
      .withTaskHandler(handler)
      .withAgent(agent);
    expect(setAgentSpy).toHaveBeenCalledWith(agent);
  });

  it('builds a server with a no-op TaskHandler', () => {
    class NoopHandler extends BaseTaskHandler {
      async handleTask(
        _context: TaskHandlerContext,
        task: ManagedTask
      ): Promise<ManagedTask> {
        return task;
      }
    }
    const server = new A2AServerBuilder({})
      .withAgentCard(backgroundCard())
      .withTaskHandler(new NoopHandler())
      .build();
    expect(server).toBeInstanceOf(A2AServer);
    expect(server.hasMethod(MESSAGE_SEND_METHOD)).toBe(true);
  });

  it('passes through signal, task, and message when the adapter invokes the handler', async () => {
    const handler: TaskHandler = {
      handleTask: vi.fn(async (_ctx, task) => task),
      setAgent: vi.fn(),
      getAgent: vi.fn(() => undefined),
    };
    const builder = new A2AServerBuilder({})
      .withAgentCard(backgroundCard())
      .withTaskHandler(handler);
    const adapter = builder.getBackgroundTaskHandler();
    expect(adapter).toBeDefined();

    const ac = new AbortController();
    const fakeTask: ManagedTask = {
      id: 't1',
      contextId: 'c1',
      state: TASK_STATE.PENDING,
      status: { state: TASK_STATE.PENDING },
      messages: [],
      artifacts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const fakeMessage: Message = {
      messageId: 'm-1',
      role: 'ROLE_USER',
      parts: [{ text: 'hi' }],
    };
    await adapter!({
      task: fakeTask,
      message: fakeMessage,
      signal: ac.signal,
    });
    expect(handler.handleTask).toHaveBeenCalledWith(
      { signal: ac.signal },
      fakeTask,
      fakeMessage
    );
  });
});

describe('A2AServerBuilder.withStreamableTaskHandler', () => {
  it('stores the handler and wires it as the streaming handler', () => {
    const handler: StreamableTaskHandler = {
      handleStreamingTask: async function* () {
        // never yields
      },
      setAgent: vi.fn(),
      getAgent: vi.fn(() => undefined),
    };
    const builder = new A2AServerBuilder({})
      .withAgentCard(streamingCard())
      .withStreamableTaskHandler(handler);
    expect(builder.getStreamableTaskHandler()).toBe(handler);
    expect(builder.getStreamingTaskHandler()).toBeDefined();
  });

  it('builds a server with a no-op StreamableTaskHandler', () => {
    class NoopHandler extends BaseStreamableTaskHandler {
      async *handleStreamingTask(): AsyncIterable<CloudEvent> {
        // never yields
      }
    }
    const server = new A2AServerBuilder({})
      .withAgentCard(streamingCard())
      .withStreamableTaskHandler(new NoopHandler())
      .build();
    expect(server).toBeInstanceOf(A2AServer);
    expect(server.hasMethod(MESSAGE_STREAM_METHOD)).toBe(true);
  });

  it('end-to-end: yields a custom CloudEvent that is forwarded to the SSE stream', async () => {
    const customEvent = createCloudEvent({
      type: 'example.custom.event',
      data: { hello: 'world' },
      subject: 'demo',
    });

    class EmitHandler extends BaseStreamableTaskHandler {
      async *handleStreamingTask(): AsyncIterable<CloudEvent> {
        yield customEvent;
      }
    }

    const server = new A2AServerBuilder({})
      .withAgentCard(streamingCard())
      .withStreamableTaskHandler(new EmitHandler())
      .build();
    await server.listen(0, '127.0.0.1');
    const port = server.address()?.port ?? 0;

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: MESSAGE_STREAM_METHOD,
        params: {
          message: {
            messageId: 'm-1',
            role: 'ROLE_USER',
            parts: [{ text: 'hi' }],
          },
        },
      }),
    });
    expect(res.status).toBe(200);

    const frames = await drainFrames(res.body as ReadableStream<Uint8Array>);
    await server.close();

    const types = frames.map((f) => f['type']);
    // Pipeline emits the initial IN_PROGRESS status frame, our custom CE, then
    // the terminal COMPLETED status frame.
    expect(types).toContain('example.custom.event');
    expect(types[0]).toBe(AGENT_EVENT_TYPE.TASK_STATUS_CHANGED);
    expect(types.at(-1)).toBe(AGENT_EVENT_TYPE.TASK_STATUS_CHANGED);
    const customFrame = frames.find(
      (f) => f['type'] === 'example.custom.event'
    );
    expect(customFrame?.['data']).toEqual({ hello: 'world' });
  });

  it('observes the AbortSignal in the handler context', async () => {
    const observedSignals: AbortSignal[] = [];
    class CapturingHandler extends BaseStreamableTaskHandler {
      async *handleStreamingTask(
        ctx: TaskHandlerContext
      ): AsyncIterable<CloudEvent> {
        observedSignals.push(ctx.signal);
        yield createCloudEvent({
          type: AGENT_EVENT_TYPE.TASK_STATUS_CHANGED,
          data: { state: TASK_STATE.COMPLETED },
        });
      }
    }

    const server = new A2AServerBuilder({})
      .withAgentCard(streamingCard())
      .withStreamableTaskHandler(new CapturingHandler())
      .build();
    await server.listen(0, '127.0.0.1');
    const port = server.address()?.port ?? 0;

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: MESSAGE_STREAM_METHOD,
        params: {
          message: {
            messageId: 'm-1',
            role: 'ROLE_USER',
            parts: [{ text: 'hi' }],
          },
        },
      }),
    });
    await drainFrames(res.body as ReadableStream<Uint8Array>);
    await server.close();

    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('A2AServerBuilder end-to-end with custom TaskHandler', () => {
  it('invokes the handler when the registered adapter runs', async () => {
    class CompleteHandler extends BaseTaskHandler {
      async handleTask(
        _ctx: TaskHandlerContext,
        task: ManagedTask
      ): Promise<ManagedTask> {
        let next = task;
        if (next.state === TASK_STATE.PENDING) {
          next = transitionTask(next, TASK_STATE.IN_PROGRESS);
        }
        return transitionTask(next, TASK_STATE.COMPLETED);
      }
    }

    const handler = new CompleteHandler();
    const builder = new A2AServerBuilder({})
      .withAgentCard(backgroundCard())
      .withTaskHandler(handler);
    const adapter = builder.getBackgroundTaskHandler();
    expect(adapter).toBeDefined();

    const ac = new AbortController();
    const initialTask: ManagedTask = {
      id: 't-1',
      contextId: 'c-1',
      state: TASK_STATE.PENDING,
      status: { state: TASK_STATE.PENDING },
      messages: [],
      artifacts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await adapter!({
      task: initialTask,
      message: {
        messageId: 'm-1',
        role: 'ROLE_USER',
        parts: [{ text: 'hi' }],
      },
      signal: ac.signal,
    });
    expect(result.state).toBe(TASK_STATE.COMPLETED);
  });
});
