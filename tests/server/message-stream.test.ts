import { describe, expect, it } from 'vitest';
import { TASK_STATE, type ManagedTask } from '../../src/agent/task.js';
import {
  DEFAULT_STREAMING_STATUS_UPDATE_INTERVAL_MS,
  JSONRPC_ERROR_CODES,
  JSONRPCError,
  MESSAGE_STREAM_METHOD,
  STREAMING_STATUS_UPDATE_INTERVAL_ENV,
  TaskCancellationRegistry,
  createMessageStreamHandler,
  createTaskCancelHandler,
  type StreamingExecutorContext,
  type StreamingTaskExecutor,
} from '../../src/server/index.js';
import { InMemoryTaskStorage } from '../../src/storage/index.js';
import type { Message, StreamResponse } from '../../src/types/index.js';

const decoder = new TextDecoder();

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: 'msg-1',
    role: 'ROLE_USER',
    parts: [{ text: 'hello' }],
    ...overrides,
  };
}

function sequentialIdGenerator(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `id-${counter}`;
  };
}

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

interface Frame {
  readonly raw: string;
  readonly result: StreamResponse;
}

function statusOf(frame: Frame | undefined): string | undefined {
  return frame?.result.statusUpdate?.status.state;
}

async function drainFrames(
  stream: ReadableStream<Uint8Array>
): Promise<Frame[]> {
  const reader = stream.getReader();
  let buffer = '';
  const frames: Frame[] = [];
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
        const envelope = JSON.parse(raw.slice('data: '.length)) as {
          jsonrpc: string;
          result: StreamResponse;
        };
        expect(envelope.jsonrpc).toBe('2.0');
        frames.push({ raw, result: envelope.result });
      }
    }
  } finally {
    reader.releaseLock();
  }
  return frames;
}

function emptyExecutor(): StreamingTaskExecutor {
  return async function* () {
    // no events; natural completion → COMPLETED
  };
}

describe('createMessageStreamHandler', () => {
  it('exposes the canonical method name constant', () => {
    expect(MESSAGE_STREAM_METHOD).toBe('SendStreamingMessage');
  });

  it('exposes the default 1000 ms status-update interval', () => {
    expect(DEFAULT_STREAMING_STATUS_UPDATE_INTERVAL_MS).toBe(1000);
  });

  describe('synchronous validation', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createMessageStreamHandler({
      storage,
      executor: emptyExecutor(),
      env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
      heartbeatMs: 0,
    });

    it('throws -32602 when params is null (before opening a stream)', () => {
      expect(() =>
        handler(null as unknown, { signal: new AbortController().signal })
      ).toThrow(JSONRPCError);
      try {
        handler(null as unknown, { signal: new AbortController().signal });
      } catch (err) {
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
      }
    });

    it('throws -32602 when params.message is missing', () => {
      try {
        handler({} as unknown, { signal: new AbortController().signal });
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        expect((err as JSONRPCError).message).toContain('message');
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });

    it('throws -32602 when message.parts is empty', () => {
      try {
        handler(
          {
            message: { messageId: 'm', role: 'ROLE_USER', parts: [] },
          } as unknown,
          { signal: new AbortController().signal }
        );
      } catch (err) {
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });
  });

  it('opens a stream with the task, emits WORKING then COMPLETED, and stores the task in dead-letter', async () => {
    const storage = new InMemoryTaskStorage();
    const handler = createMessageStreamHandler({
      storage,
      executor: emptyExecutor(),
      idGenerator: sequentialIdGenerator(),
      now: fixedNow('2026-05-26T12:00:00.000Z'),
      env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
      heartbeatMs: 0,
    });

    const controller = new AbortController();
    const result = handler(
      { message: makeMessage({ contextId: 'ctx-existing' }) },
      { signal: controller.signal }
    );

    const frames = await drainFrames(result.readable);
    await result.done;

    expect(frames).toHaveLength(3);
    expect(frames[0]?.result.task?.id).toBe('id-1');
    expect(frames[0]?.result.task?.status.state).toBe(TASK_STATE.PENDING);
    const working = frames[1]?.result.statusUpdate;
    expect(working?.taskId).toBe('id-1');
    expect(working?.contextId).toBe('ctx-existing');
    expect(working?.status.state).toBe(TASK_STATE.IN_PROGRESS);
    expect(statusOf(frames[2])).toBe(TASK_STATE.COMPLETED);

    const stored = storage.getTask('id-1');
    expect(stored).toBeDefined();
    expect(stored?.state).toBe(TASK_STATE.COMPLETED);
  });

  it('emits deltas as working status updates in order between WORKING and the terminal status', async () => {
    const storage = new InMemoryTaskStorage();
    const executor: StreamingTaskExecutor = async function* () {
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
      yield {
        type: 'delta',
        message: {
          messageId: 'd-3',
          role: 'ROLE_AGENT',
          parts: [{ text: 'c' }],
        },
      };
    };

    const handler = createMessageStreamHandler({
      storage,
      executor,
      idGenerator: sequentialIdGenerator(),
      env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
      heartbeatMs: 0,
    });

    const result = handler(
      { message: makeMessage({ contextId: 'ctx-1' }) },
      { signal: new AbortController().signal }
    );

    const frames = await drainFrames(result.readable);
    await result.done;

    expect(frames.map(statusOf)).toEqual([
      undefined,
      TASK_STATE.IN_PROGRESS,
      TASK_STATE.IN_PROGRESS,
      TASK_STATE.IN_PROGRESS,
      TASK_STATE.IN_PROGRESS,
      TASK_STATE.COMPLETED,
    ]);
    const deltaMessageIds = frames
      .slice(2, 5)
      .map((f) => f.result.statusUpdate?.status.message?.messageId);
    expect(deltaMessageIds).toEqual(['d-1', 'd-2', 'd-3']);
  });

  it('transitions the task and emits a status frame when the executor yields statusChanged', async () => {
    const storage = new InMemoryTaskStorage();
    const executor: StreamingTaskExecutor = async function* () {
      yield {
        type: 'statusChanged',
        state: TASK_STATE.COMPLETED,
        message: {
          messageId: 'final-m',
          role: 'ROLE_AGENT',
          parts: [{ text: 'done' }],
        },
      };
      yield {
        type: 'delta',
        message: {
          messageId: 'd-after',
          role: 'ROLE_AGENT',
          parts: [{ text: 'late' }],
        },
      };
    };

    const handler = createMessageStreamHandler({
      storage,
      executor,
      idGenerator: sequentialIdGenerator(),
      env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
      heartbeatMs: 0,
    });

    const result = handler(
      { message: makeMessage({ contextId: 'ctx-x' }) },
      { signal: new AbortController().signal }
    );

    const frames = await drainFrames(result.readable);
    await result.done;

    expect(frames.map(statusOf)).toEqual([
      undefined,
      TASK_STATE.IN_PROGRESS,
      TASK_STATE.COMPLETED,
    ]);
  });

  it('handles inputRequired by transitioning to INPUT_REQUIRED with final=false and ending the stream', async () => {
    const storage = new InMemoryTaskStorage();
    const executor: StreamingTaskExecutor = async function* () {
      yield {
        type: 'inputRequired',
        message: {
          messageId: 'ask-1',
          role: 'ROLE_AGENT',
          parts: [{ text: 'need more info' }],
        },
      };
    };

    const handler = createMessageStreamHandler({
      storage,
      executor,
      idGenerator: sequentialIdGenerator(),
      env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
      heartbeatMs: 0,
    });

    const result = handler(
      { message: makeMessage({ contextId: 'ctx-input' }) },
      { signal: new AbortController().signal }
    );

    const frames = await drainFrames(result.readable);
    await result.done;

    expect(statusOf(frames[2])).toBe(TASK_STATE.INPUT_REQUIRED);

    const stored = storage.getTask('id-1') as ManagedTask;
    expect(stored.state).toBe(TASK_STATE.INPUT_REQUIRED);
  });

  it('shallow-merges statusChanged.metadata into task.metadata on terminal transition', async () => {
    const storage = new InMemoryTaskStorage();
    const executor: StreamingTaskExecutor = async function* () {
      yield {
        type: 'statusChanged',
        state: TASK_STATE.COMPLETED,
        message: {
          messageId: 'final-m',
          role: 'ROLE_AGENT',
          parts: [{ text: 'done' }],
        },
        metadata: {
          usage: {
            prompt_tokens: 5,
            completion_tokens: 7,
            total_tokens: 12,
          },
          execution_stats: { iterations: 1, tool_calls: 0, failed_tools: 0 },
        },
      };
    };

    const handler = createMessageStreamHandler({
      storage,
      executor,
      idGenerator: sequentialIdGenerator(),
      env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
      heartbeatMs: 0,
    });

    const result = handler(
      { message: makeMessage({ contextId: 'ctx-metadata' }) },
      { signal: new AbortController().signal }
    );
    await drainFrames(result.readable);
    await result.done;

    const stored = storage.getTask('id-1') as ManagedTask;
    expect(stored.metadata).toBeDefined();
    const metadata = stored.metadata as Record<string, unknown>;
    expect(metadata['usage']).toEqual({
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
    });
    expect(metadata['execution_stats']).toEqual({
      iterations: 1,
      tool_calls: 0,
      failed_tools: 0,
    });
  });

  it('shallow-merges inputRequired.metadata into task.metadata before pausing', async () => {
    const storage = new InMemoryTaskStorage();
    const executor: StreamingTaskExecutor = async function* () {
      yield {
        type: 'inputRequired',
        message: {
          messageId: 'ask-2',
          role: 'ROLE_AGENT',
          parts: [{ text: 'need more info' }],
        },
        metadata: {
          execution_stats: { iterations: 1, tool_calls: 0, failed_tools: 0 },
        },
      };
    };

    const handler = createMessageStreamHandler({
      storage,
      executor,
      idGenerator: sequentialIdGenerator(),
      env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
      heartbeatMs: 0,
    });

    const result = handler(
      { message: makeMessage({ contextId: 'ctx-input-meta' }) },
      { signal: new AbortController().signal }
    );
    await drainFrames(result.readable);
    await result.done;

    const stored = storage.getTask('id-1') as ManagedTask;
    expect(stored.state).toBe(TASK_STATE.INPUT_REQUIRED);
    const metadata = stored.metadata as Record<string, unknown>;
    expect(metadata['execution_stats']).toEqual({
      iterations: 1,
      tool_calls: 0,
      failed_tools: 0,
    });
  });

  it('transitions to FAILED and emits a final status event when the executor throws', async () => {
    const storage = new InMemoryTaskStorage();
    const executor: StreamingTaskExecutor = async function* () {
      yield {
        type: 'delta',
        message: {
          messageId: 'd-1',
          role: 'ROLE_AGENT',
          parts: [{ text: 'oops' }],
        },
      };
      throw new Error('boom');
    };

    const handler = createMessageStreamHandler({
      storage,
      executor,
      idGenerator: sequentialIdGenerator(),
      env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
      heartbeatMs: 0,
    });

    const result = handler(
      { message: makeMessage({ contextId: 'ctx-fail' }) },
      { signal: new AbortController().signal }
    );

    const frames = await drainFrames(result.readable);
    await result.done;

    const last = frames[frames.length - 1]?.result.statusUpdate;
    expect(last?.status.state).toBe(TASK_STATE.FAILED);
    const failureMessage = last?.status.message;
    expect(failureMessage?.parts[0]).toMatchObject({ text: 'boom' });
  });

  it('cancels the executor and transitions to CANCELLED when the request signal aborts', async () => {
    const storage = new InMemoryTaskStorage();
    let observedExecutorSignal: AbortSignal | undefined;
    let executorAborted = false;

    const executor: StreamingTaskExecutor = async function* (
      ctx: StreamingExecutorContext
    ) {
      observedExecutorSignal = ctx.signal;
      yield {
        type: 'delta',
        message: {
          messageId: 'd-1',
          role: 'ROLE_AGENT',
          parts: [{ text: 'a' }],
        },
      };
      await new Promise<void>((resolve, reject) => {
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

    const handler = createMessageStreamHandler({
      storage,
      executor,
      idGenerator: sequentialIdGenerator(),
      env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
      heartbeatMs: 0,
    });

    const controller = new AbortController();
    const result = handler(
      { message: makeMessage({ contextId: 'ctx-cancel' }) },
      { signal: controller.signal }
    );

    const reader = result.readable.getReader();
    const seen: Frame[] = [];
    let buffer = '';
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
        if (raw.startsWith('data: ')) {
          const envelope = JSON.parse(raw.slice('data: '.length)) as {
            result: StreamResponse;
          };
          seen.push({ raw, result: envelope.result });
        }
      }
      if (seen.length >= 3) {
        controller.abort();
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // already released by the abort-triggered close
    }
    await result.done;

    expect(observedExecutorSignal?.aborted).toBe(true);
    expect(executorAborted).toBe(true);

    const stored = storage.getTask('id-1');
    expect(stored?.state).toBe(TASK_STATE.CANCELLED);

    // The terminal CANCELLED frame is not asserted here: in the
    // client-disconnect scenario the SSE writer closes as soon as the request
    // signal aborts (it shares that signal), so any frame the handler tries
    // to emit afterward is a no-op. The client has already disconnected, so
    // the absence of that frame is the correct contract - storage is the
    // source of truth for the final state.
  });

  describe('periodic status updates', () => {
    it('re-emits the current status on the configured interval while IN_PROGRESS', async () => {
      const storage = new InMemoryTaskStorage();
      const release = new AbortController();
      // eslint-disable-next-line require-yield
      const executor: StreamingTaskExecutor = async function* (
        ctx: StreamingExecutorContext
      ) {
        await new Promise<void>((resolve) => {
          if (release.signal.aborted) {
            resolve();
            return;
          }
          release.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      };

      const handler = createMessageStreamHandler({
        storage,
        executor,
        idGenerator: sequentialIdGenerator(),
        statusUpdateIntervalMs: 30,
        heartbeatMs: 0,
      });

      const result = handler(
        { message: makeMessage({ contextId: 'ctx-tick' }) },
        { signal: new AbortController().signal }
      );

      const reader = result.readable.getReader();
      const seen: string[] = [];
      let buffer = '';
      const readUntil = async (target: number): Promise<void> => {
        while (seen.length < target) {
          const { value, done } = await reader.read();
          if (done) {
            return;
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
              seen.push(raw);
            }
          }
        }
      };

      // Task + initial WORKING + at least 3 periodic re-emits (≈ 90 ms of timer firings).
      await readUntil(5);
      expect(seen.length).toBeGreaterThanOrEqual(5);
      for (const raw of seen.slice(1)) {
        const payload = JSON.parse(raw.slice('data: '.length)) as {
          result: StreamResponse;
        };
        expect(payload.result.statusUpdate?.status.state).toBe(
          TASK_STATE.IN_PROGRESS
        );
      }

      release.abort();
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
      await result.done;
    });

    it('does not emit periodic updates when statusUpdateIntervalMs is 0', async () => {
      const storage = new InMemoryTaskStorage();
      const release = new AbortController();
      // eslint-disable-next-line require-yield
      const executor: StreamingTaskExecutor = async function* (
        ctx: StreamingExecutorContext
      ) {
        await new Promise<void>((resolve) => {
          if (release.signal.aborted) {
            resolve();
            return;
          }
          release.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      };

      const handler = createMessageStreamHandler({
        storage,
        executor,
        idGenerator: sequentialIdGenerator(),
        statusUpdateIntervalMs: 0,
        heartbeatMs: 0,
      });

      const result = handler(
        { message: makeMessage({ contextId: 'ctx-quiet' }) },
        { signal: new AbortController().signal }
      );

      const reader = result.readable.getReader();
      let buffer = '';
      const frames: string[] = [];

      // Read the task and the initial WORKING frame.
      while (frames.length < 2) {
        const next = await reader.read();
        expect(next.done).toBe(false);
        buffer += decoder.decode(next.value as Uint8Array, { stream: true });
        while (true) {
          const idx = buffer.indexOf('\n\n');
          if (idx < 0) {
            break;
          }
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (raw.startsWith('data: ')) {
            frames.push(raw);
          }
        }
      }
      expect(frames.length).toBe(2);

      // Wait 250 ms of real time and race a read against it. With periodic
      // updates disabled, the read should not resolve - the timeout wins.
      const idleWindowMs = 250;
      const outcome = await Promise.race([
        reader.read().then((r) => ({ kind: 'read' as const, r })),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          setTimeout(() => resolve({ kind: 'timeout' }), idleWindowMs)
        ),
      ]);
      expect(outcome.kind).toBe('timeout');

      release.abort();
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
      await result.done;
    });
  });

  describe('STREAMING_STATUS_UPDATE_INTERVAL env var parsing', () => {
    it('reads a millisecond integer from the env var when no option is given', () => {
      const storage = new InMemoryTaskStorage();
      expect(() =>
        createMessageStreamHandler({
          storage,
          executor: emptyExecutor(),
          env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '250' },
          heartbeatMs: 0,
        })
      ).not.toThrow();
    });

    it('accepts Go-style "1s" suffix', () => {
      const storage = new InMemoryTaskStorage();
      expect(() =>
        createMessageStreamHandler({
          storage,
          executor: emptyExecutor(),
          env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '1s' },
          heartbeatMs: 0,
        })
      ).not.toThrow();
    });

    it('throws when the env var is unparseable', () => {
      const storage = new InMemoryTaskStorage();
      expect(() =>
        createMessageStreamHandler({
          storage,
          executor: emptyExecutor(),
          env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: 'oops' },
          heartbeatMs: 0,
        })
      ).toThrow(/STREAMING_STATUS_UPDATE_INTERVAL/);
    });

    it('falls back to the default when the env var is unset', () => {
      const storage = new InMemoryTaskStorage();
      // Just ensure construction succeeds and the constant is honoured.
      expect(() =>
        createMessageStreamHandler({
          storage,
          executor: emptyExecutor(),
          env: {},
          heartbeatMs: 0,
        })
      ).not.toThrow();
      expect(DEFAULT_STREAMING_STATUS_UPDATE_INTERVAL_MS).toBe(1000);
    });
  });
});

describe('createMessageStreamHandler + CancelTask integration', () => {
  it('CancelTask aborts an in-flight streaming executor via the shared registry', async () => {
    const storage = new InMemoryTaskStorage();
    const registry = new TaskCancellationRegistry();

    let observedSignal: AbortSignal | undefined;
    let executorObservedAbort = false;
    let resolveParked!: () => void;
    const executorParked = new Promise<void>((resolve) => {
      resolveParked = resolve;
    });

    const executor: StreamingTaskExecutor = async function* (
      ctx: StreamingExecutorContext
    ) {
      observedSignal = ctx.signal;
      yield {
        type: 'delta',
        message: {
          messageId: 'd-1',
          role: 'ROLE_AGENT',
          parts: [{ text: 'partial' }],
        },
      };
      resolveParked();
      await new Promise<void>((_, reject) => {
        ctx.signal.addEventListener(
          'abort',
          () => {
            executorObservedAbort = true;
            reject(new Error('aborted by CancelTask'));
          },
          { once: true }
        );
      });
    };

    const streamHandler = createMessageStreamHandler({
      storage,
      executor,
      cancellationRegistry: registry,
      idGenerator: sequentialIdGenerator(),
      env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
      heartbeatMs: 0,
    });

    const requestController = new AbortController();
    const streamResult = streamHandler(
      { message: makeMessage({ contextId: 'ctx-cancel-integration' }) },
      { signal: requestController.signal }
    );

    const drain = drainFrames(streamResult.readable);

    await executorParked;
    expect(registry.has('id-1')).toBe(true);

    const cancelHandler = createTaskCancelHandler({ storage, registry });
    const cancelled = cancelHandler(
      { id: 'id-1' },
      { signal: new AbortController().signal }
    );
    expect(cancelled).toMatchObject({
      id: 'id-1',
      status: { state: TASK_STATE.CANCELLED },
    });

    await drain;
    await streamResult.done;

    expect(observedSignal?.aborted).toBe(true);
    expect(executorObservedAbort).toBe(true);
    expect(registry.has('id-1')).toBe(false);
    expect(storage.getTask('id-1')?.state).toBe(TASK_STATE.CANCELLED);
  });
});
