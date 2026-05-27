import { afterEach, describe, expect, it } from 'vitest';
import { TASK_STATE } from '../../src/agent/task.js';
import {
  A2AServer,
  AGENT_EVENT_TYPE,
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  MESSAGE_STREAM_METHOD,
  STREAMING_STATUS_UPDATE_INTERVAL_ENV,
  createA2AServer,
  createMessageStreamHandler,
  type StreamingExecutorContext,
  type StreamingTaskExecutor,
} from '../../src/server/index.js';
import { InMemoryTaskStorage } from '../../src/storage/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';
import type { TaskStatusUpdateEvent } from '../../src/types/index.js';

const decoder = new TextDecoder();

function makeCard(): AgentCard {
  return {
    name: 'streaming-agent',
    description: 'Agent under test',
    version: '0.0.0',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: { streaming: true },
    skills: [
      { id: 'echo', name: 'Echo', description: 'Echo input.', tags: [] },
    ],
  };
}

function sequentialIdGenerator(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `id-${counter}`;
  };
}

async function start(server: A2AServer): Promise<string> {
  await server.listen(0, '127.0.0.1');
  const addr = server.address();
  if (addr === null) {
    throw new Error('server did not report a listening address');
  }
  return `http://127.0.0.1:${addr.port}`;
}

interface Frame {
  readonly raw: string;
  readonly json: { type: string; data: unknown; id?: string };
}

async function readFrames(
  res: Response,
  options: { until?: (frames: Frame[]) => boolean; signal?: AbortSignal } = {}
): Promise<Frame[]> {
  if (res.body === null) {
    throw new Error('response had no body');
  }
  const reader = res.body.getReader();
  let buffer = '';
  const frames: Frame[] = [];
  try {
    while (true) {
      if (options.signal?.aborted) {
        return frames;
      }
      const { value, done } = await reader.read();
      if (done) {
        return frames;
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx < 0) {
          break;
        }
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (raw.startsWith('data: ')) {
          frames.push({
            raw,
            json: JSON.parse(raw.slice('data: '.length)) as {
              type: string;
              data: unknown;
              id?: string;
            },
          });
        }
      }
      if (options.until?.(frames)) {
        return frames;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released by cancel
    }
  }
}

describe('message/stream JSON-RPC conformance', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('responds with text/event-stream and emits WORKING → DELTA × N → COMPLETED in order', async () => {
    const storage = new InMemoryTaskStorage();
    const executor: StreamingTaskExecutor = async function* () {
      yield {
        type: 'delta',
        message: {
          messageId: 'chunk-1',
          role: 'ROLE_AGENT',
          parts: [{ text: 'hel' }],
        },
      };
      yield {
        type: 'delta',
        message: {
          messageId: 'chunk-2',
          role: 'ROLE_AGENT',
          parts: [{ text: 'lo ' }],
        },
      };
      yield {
        type: 'delta',
        message: {
          messageId: 'chunk-3',
          role: 'ROLE_AGENT',
          parts: [{ text: 'world' }],
        },
      };
    };

    const server = createA2AServer({ card: makeCard() });
    server.registerStreamingMethod(
      MESSAGE_STREAM_METHOD,
      createMessageStreamHandler({
        storage,
        executor,
        idGenerator: sequentialIdGenerator(),
        env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
        heartbeatMs: 0,
      })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 'req-1',
        method: MESSAGE_STREAM_METHOD,
        params: {
          message: {
            messageId: 'user-1',
            role: 'ROLE_USER',
            contextId: 'ctx-1',
            parts: [{ text: 'hello agent' }],
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);

    const frames = await readFrames(res);
    const types = frames.map((f) => f.json.type);

    expect(types).toEqual([
      AGENT_EVENT_TYPE.TASK_STATUS_CHANGED, // WORKING
      AGENT_EVENT_TYPE.DELTA,
      AGENT_EVENT_TYPE.DELTA,
      AGENT_EVENT_TYPE.DELTA,
      AGENT_EVENT_TYPE.TASK_STATUS_CHANGED, // COMPLETED (final)
    ]);

    const first = frames[0]?.json.data as TaskStatusUpdateEvent;
    expect(first.taskId).toBe('id-1');
    expect(first.contextId).toBe('ctx-1');
    expect(first.status.state).toBe(TASK_STATE.IN_PROGRESS);
    expect(first.final).toBe(false);

    const last = frames[frames.length - 1]?.json.data as TaskStatusUpdateEvent;
    expect(last.status.state).toBe(TASK_STATE.COMPLETED);
    expect(last.final).toBe(true);

    const stored = storage.getTask('id-1');
    expect(stored?.state).toBe(TASK_STATE.COMPLETED);
  });

  it('wraps each frame in a CloudEvents v1.0 envelope', async () => {
    const storage = new InMemoryTaskStorage();
    const executor: StreamingTaskExecutor = async function* () {
      yield {
        type: 'delta',
        message: {
          messageId: 'd-1',
          role: 'ROLE_AGENT',
          parts: [{ text: 'x' }],
        },
      };
    };

    const server = createA2AServer({ card: makeCard() });
    server.registerStreamingMethod(
      MESSAGE_STREAM_METHOD,
      createMessageStreamHandler({
        storage,
        executor,
        idGenerator: sequentialIdGenerator(),
        env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
        heartbeatMs: 0,
      })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: MESSAGE_STREAM_METHOD,
        params: {
          message: {
            messageId: 'u-1',
            role: 'ROLE_USER',
            contextId: 'ctx-ce',
            parts: [{ text: 'hi' }],
          },
        },
      }),
    });

    const frames = await readFrames(res);
    for (const frame of frames) {
      const envelope = frame.json as unknown as Record<string, unknown>;
      expect(envelope['specversion']).toBe('1.0');
      expect(typeof envelope['id']).toBe('string');
      expect(typeof envelope['source']).toBe('string');
      expect(typeof envelope['type']).toBe('string');
      expect(envelope['datacontenttype']).toBe('application/json');
      expect(envelope['subject']).toBe('id-1');
    }
  });

  it('returns a regular JSON-RPC -32602 error when params validation fails (no SSE stream opened)', async () => {
    const storage = new InMemoryTaskStorage();
    const executor: StreamingTaskExecutor = async function* () {
      // never reached
    };

    const server = createA2AServer({ card: makeCard() });
    server.registerStreamingMethod(
      MESSAGE_STREAM_METHOD,
      createMessageStreamHandler({
        storage,
        executor,
        env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
        heartbeatMs: 0,
      })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 2,
        method: MESSAGE_STREAM_METHOD,
        params: {},
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as {
      id: number;
      error: { code: number; message: string };
    };
    expect(body.id).toBe(2);
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_PARAMS);
    expect(body.error.message).toContain('message');

    expect(storage.queueLength()).toBe(0);
  });

  it('cancels the task via AbortSignal and emits a final CANCELLED status when the client disconnects', async () => {
    const storage = new InMemoryTaskStorage();
    let executorSignal: AbortSignal | undefined;
    let executorAborted = false;

    const executor: StreamingTaskExecutor = async function* (
      ctx: StreamingExecutorContext
    ) {
      executorSignal = ctx.signal;
      yield {
        type: 'delta',
        message: {
          messageId: 'd-1',
          role: 'ROLE_AGENT',
          parts: [{ text: 'a' }],
        },
      };
      yield {
        type: 'delta',
        message: {
          messageId: 'd-2',
          role: 'ROLE_AGENT',
          parts: [{ text: 'b' }],
        },
      };
      await new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener(
          'abort',
          () => {
            executorAborted = true;
            reject(new Error('aborted'));
          },
          { once: true }
        );
      });
    };

    const server = createA2AServer({ card: makeCard() });
    server.registerStreamingMethod(
      MESSAGE_STREAM_METHOD,
      createMessageStreamHandler({
        storage,
        executor,
        idGenerator: sequentialIdGenerator(),
        env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
        heartbeatMs: 0,
      })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const abort = new AbortController();
    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 'req-cancel',
        method: MESSAGE_STREAM_METHOD,
        params: {
          message: {
            messageId: 'u-1',
            role: 'ROLE_USER',
            contextId: 'ctx-cancel',
            parts: [{ text: 'go' }],
          },
        },
      }),
      signal: abort.signal,
    });

    expect(res.status).toBe(200);

    // Wait until we've seen the initial WORKING + at least one delta, then disconnect.
    if (res.body === null) {
      throw new Error('response had no body');
    }
    const reader = res.body.getReader();
    let buffer = '';
    let frames = 0;
    try {
      while (frames < 2) {
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
          buffer = buffer.slice(idx + 2);
          frames += 1;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }

    abort.abort();

    // Allow the server to observe the disconnect and run its cleanup.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const stored = storage.getTask('id-1');
      if (stored?.state === TASK_STATE.CANCELLED) {
        break;
      }
    }

    expect(executorSignal?.aborted).toBe(true);
    expect(executorAborted).toBe(true);

    const stored = storage.getTask('id-1');
    expect(stored?.state).toBe(TASK_STATE.CANCELLED);
  });

  it('honours a streaming method even when a same-named regular handler also exists (streaming wins)', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });

    server.registerMethod(MESSAGE_STREAM_METHOD, () => ({
      shouldNotBeUsed: true,
    }));
    server.registerStreamingMethod(
      MESSAGE_STREAM_METHOD,
      createMessageStreamHandler({
        storage,
        executor: async function* () {
          /* no events */
        },
        idGenerator: sequentialIdGenerator(),
        env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
        heartbeatMs: 0,
      })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: MESSAGE_STREAM_METHOD,
        params: {
          message: {
            messageId: 'u-1',
            role: 'ROLE_USER',
            contextId: 'ctx-1',
            parts: [{ text: 'go' }],
          },
        },
      }),
    });

    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    await readFrames(res);
  });
});
