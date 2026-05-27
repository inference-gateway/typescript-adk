import { afterEach, describe, expect, it } from 'vitest';
import {
  TASK_STATE,
  createTask,
  transitionTask,
  type ManagedTask,
} from '../../src/agent/task.js';
import {
  A2AServer,
  AGENT_EVENT_TYPE,
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  JSONRPCError,
  MESSAGE_STREAM_METHOD,
  STREAMING_STATUS_UPDATE_INTERVAL_ENV,
  TASK_RESUBSCRIBE_METHOD,
  TaskEventBus,
  TaskEventBusRegistry,
  createA2AServer,
  createMessageStreamHandler,
  createTaskResubscribeHandler,
  type StreamingExecutorContext,
  type StreamingTaskExecutor,
} from '../../src/server/index.js';
import { InMemoryTaskStorage } from '../../src/storage/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';
import type { Message, TaskStatusUpdateEvent } from '../../src/types/index.js';

const decoder = new TextDecoder();

function makeCard(): AgentCard {
  return {
    name: 'resubscribe-agent',
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

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

function makeMessage(id: string, text: string): Message {
  return {
    messageId: id,
    role: 'ROLE_USER',
    parts: [{ text }],
    contextId: 'ctx-1',
  };
}

function seedTaskInState(
  storage: InMemoryTaskStorage,
  id: string,
  state:
    | typeof TASK_STATE.PENDING
    | typeof TASK_STATE.IN_PROGRESS
    | typeof TASK_STATE.COMPLETED
    | typeof TASK_STATE.FAILED
    | typeof TASK_STATE.CANCELLED
): ManagedTask {
  const pending = createTask({
    id,
    contextId: 'ctx-1',
    messages: [makeMessage('m-1', 'hello')],
    now: fixedNow('2026-05-27T12:00:00.000Z'),
  });
  if (state === TASK_STATE.PENDING) {
    storage.enqueue(pending);
    return pending;
  }
  storage.createActive(pending);
  let task: ManagedTask = transitionTask(pending, TASK_STATE.IN_PROGRESS, {
    now: fixedNow('2026-05-27T12:01:00.000Z'),
  });
  storage.updateActive(task);
  if (
    state === TASK_STATE.COMPLETED ||
    state === TASK_STATE.FAILED ||
    state === TASK_STATE.CANCELLED
  ) {
    task = transitionTask(task, state, {
      now: fixedNow('2026-05-27T12:02:00.000Z'),
    });
    storage.storeDeadLetter(task);
  }
  return task;
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
  options: { until?: (frames: Frame[]) => boolean } = {}
): Promise<Frame[]> {
  if (res.body === null) {
    throw new Error('response had no body');
  }
  const reader = res.body.getReader();
  let buffer = '';
  const frames: Frame[] = [];
  try {
    while (true) {
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
      // already released
    }
  }
}

describe('createTaskResubscribeHandler', () => {
  describe('synchronous validation', () => {
    it('throws JSONRPCError(-32602) when params are not an object', () => {
      const storage = new InMemoryTaskStorage();
      const handler = createTaskResubscribeHandler({ storage });
      for (const params of [null, 'bad', 42, ['arr']]) {
        try {
          handler(params, { signal: new AbortController().signal });
          throw new Error('expected handler to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(JSONRPCError);
          expect((err as JSONRPCError).code).toBe(
            JSONRPC_ERROR_CODES.INVALID_PARAMS
          );
        }
      }
    });

    it('throws JSONRPCError(-32602) when taskId is missing or empty', () => {
      const storage = new InMemoryTaskStorage();
      const handler = createTaskResubscribeHandler({ storage });
      for (const params of [{}, { taskId: '' }, { taskId: 42 }]) {
        try {
          handler(params, { signal: new AbortController().signal });
          throw new Error('expected handler to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(JSONRPCError);
          expect((err as JSONRPCError).code).toBe(
            JSONRPC_ERROR_CODES.INVALID_PARAMS
          );
          expect((err as JSONRPCError).message).toContain('taskId');
        }
      }
    });

    it('throws JSONRPCError(-32602) when the task is not found in storage', () => {
      const storage = new InMemoryTaskStorage();
      const handler = createTaskResubscribeHandler({ storage });
      try {
        handler(
          { taskId: 'missing' },
          { signal: new AbortController().signal }
        );
        throw new Error('expected handler to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        expect((err as JSONRPCError).message).toBe('task not found');
      }
    });

    it('rejects metadata that is not an object', () => {
      const storage = new InMemoryTaskStorage();
      const handler = createTaskResubscribeHandler({ storage });
      try {
        handler(
          { taskId: 'task-1', metadata: 'not-an-object' },
          { signal: new AbortController().signal }
        );
        throw new Error('expected handler to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).message).toContain('metadata');
      }
    });
  });

  describe('terminal task replay', () => {
    it('emits a single final status frame for a COMPLETED task and closes', async () => {
      const storage = new InMemoryTaskStorage();
      seedTaskInState(storage, 'task-1', TASK_STATE.COMPLETED);

      const handler = createTaskResubscribeHandler({ storage });
      const { readable, done } = handler(
        { taskId: 'task-1' },
        { signal: new AbortController().signal }
      );

      const frames = await collectFrames(readable);
      await done;
      expect(frames).toHaveLength(1);
      expect(frames[0]?.json.type).toBe(AGENT_EVENT_TYPE.TASK_STATUS_CHANGED);
      const data = frames[0]?.json.data as TaskStatusUpdateEvent;
      expect(data.taskId).toBe('task-1');
      expect(data.status.state).toBe(TASK_STATE.COMPLETED);
      expect(data.final).toBe(true);
    });

    for (const terminal of [TASK_STATE.FAILED, TASK_STATE.CANCELLED] as const) {
      it(`emits final=true for a ${terminal} task`, async () => {
        const storage = new InMemoryTaskStorage();
        seedTaskInState(storage, 'task-1', terminal);

        const handler = createTaskResubscribeHandler({ storage });
        const { readable, done } = handler(
          { taskId: 'task-1' },
          { signal: new AbortController().signal }
        );

        const frames = await collectFrames(readable);
        await done;
        expect(frames).toHaveLength(1);
        const data = frames[0]?.json.data as TaskStatusUpdateEvent;
        expect(data.status.state).toBe(terminal);
        expect(data.final).toBe(true);
      });
    }
  });

  describe('non-terminal task replay (no live bus)', () => {
    it('emits a single non-final status frame and closes when no event bus is registered', async () => {
      const storage = new InMemoryTaskStorage();
      seedTaskInState(storage, 'task-1', TASK_STATE.IN_PROGRESS);

      const handler = createTaskResubscribeHandler({ storage });
      const { readable, done } = handler(
        { taskId: 'task-1' },
        { signal: new AbortController().signal }
      );

      const frames = await collectFrames(readable);
      await done;
      expect(frames).toHaveLength(1);
      const data = frames[0]?.json.data as TaskStatusUpdateEvent;
      expect(data.status.state).toBe(TASK_STATE.IN_PROGRESS);
      expect(data.final).toBe(false);
    });

    it('uses the bus replay buffer when present even if no listeners are live', async () => {
      const storage = new InMemoryTaskStorage();
      seedTaskInState(storage, 'task-1', TASK_STATE.IN_PROGRESS);

      const registry = new TaskEventBusRegistry();
      const bus = registry.getOrCreate('task-1');
      bus.publish({
        specversion: '1.0',
        id: 'evt-1',
        source: 'test',
        type: AGENT_EVENT_TYPE.TASK_STATUS_CHANGED,
        data: {
          taskId: 'task-1',
          contextId: 'ctx-1',
          status: { state: TASK_STATE.IN_PROGRESS },
          final: false,
        } satisfies TaskStatusUpdateEvent,
      });
      bus.close();

      const handler = createTaskResubscribeHandler({
        storage,
        eventBusRegistry: registry,
      });
      const { readable, done } = handler(
        { taskId: 'task-1' },
        { signal: new AbortController().signal }
      );

      const frames = await collectFrames(readable);
      await done;
      expect(frames).toHaveLength(1);
      expect(frames[0]?.json.id).toBe('evt-1');
    });
  });
});

describe('tasks/resubscribe end-to-end via A2AServer', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('returns a JSON-RPC -32602 error (no SSE stream) when the task is unknown', async () => {
    const storage = new InMemoryTaskStorage();
    const registry = new TaskEventBusRegistry();

    const server = createA2AServer({ card: makeCard() });
    server.registerStreamingMethod(
      TASK_RESUBSCRIBE_METHOD,
      createTaskResubscribeHandler({ storage, eventBusRegistry: registry })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: TASK_RESUBSCRIBE_METHOD,
        params: { taskId: 'missing' },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as {
      id: number;
      error: { code: number; message: string };
    };
    expect(body.id).toBe(1);
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_PARAMS);
    expect(body.error.message).toBe('task not found');
  });

  it('replays the bus last status, forwards live events, then closes when the producer ends (replay-then-live)', async () => {
    const storage = new InMemoryTaskStorage();
    const registry = new TaskEventBusRegistry();

    // Producer waits for a signal before yielding the next batch of deltas, so
    // the test can interleave a resubscribe request between the initial
    // WORKING transition and the deltas.
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });

    const executor: StreamingTaskExecutor = async function* (
      _ctx: StreamingExecutorContext
    ) {
      await gate;
      yield {
        type: 'delta',
        message: {
          messageId: 'd-1',
          role: 'ROLE_AGENT',
          parts: [{ text: 'one' }],
        },
      };
      yield {
        type: 'delta',
        message: {
          messageId: 'd-2',
          role: 'ROLE_AGENT',
          parts: [{ text: 'two' }],
        },
      };
    };

    const server = createA2AServer({ card: makeCard() });
    server.registerStreamingMethod(
      MESSAGE_STREAM_METHOD,
      createMessageStreamHandler({
        storage,
        executor,
        idGenerator: () => 'task-1',
        env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
        heartbeatMs: 0,
        eventBusRegistry: registry,
      })
    );
    server.registerStreamingMethod(
      TASK_RESUBSCRIBE_METHOD,
      createTaskResubscribeHandler({
        storage,
        eventBusRegistry: registry,
        heartbeatMs: 0,
      })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    // Start the producing stream. Don't block on it: we only need its body
    // to drive the bus.
    const producerRes = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: MESSAGE_STREAM_METHOD,
        params: {
          message: {
            messageId: 'user-1',
            role: 'ROLE_USER',
            contextId: 'ctx-1',
            parts: [{ text: 'hello' }],
          },
        },
      }),
    });
    expect(producerRes.status).toBe(200);

    // Wait until the producer has emitted its WORKING transition (so the bus
    // has a non-empty replay buffer).
    await waitForBusStatus(registry, 'task-1');

    // Now resubscribe.
    const resubRes = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 2,
        method: TASK_RESUBSCRIBE_METHOD,
        params: { taskId: 'task-1' },
      }),
    });
    expect(resubRes.status).toBe(200);
    expect(resubRes.headers.get('content-type')).toMatch(/^text\/event-stream/);

    // Release the producer so deltas + final state flow.
    resolveGate?.();

    const [producerFrames, resubFrames] = await Promise.all([
      readFrames(producerRes),
      readFrames(resubRes),
    ]);

    const producerTypes = producerFrames.map((f) => f.json.type);
    expect(producerTypes).toEqual([
      AGENT_EVENT_TYPE.TASK_STATUS_CHANGED,
      AGENT_EVENT_TYPE.DELTA,
      AGENT_EVENT_TYPE.DELTA,
      AGENT_EVENT_TYPE.TASK_STATUS_CHANGED,
    ]);

    // The resubscriber must see:
    //  - the replay frame (initial WORKING status)
    //  - both deltas
    //  - the final COMPLETED status
    const resubTypes = resubFrames.map((f) => f.json.type);
    expect(resubTypes[0]).toBe(AGENT_EVENT_TYPE.TASK_STATUS_CHANGED);
    expect(resubTypes[resubTypes.length - 1]).toBe(
      AGENT_EVENT_TYPE.TASK_STATUS_CHANGED
    );
    expect(resubTypes.filter((t) => t === AGENT_EVENT_TYPE.DELTA)).toHaveLength(
      2
    );

    const initial = resubFrames[0]?.json.data as TaskStatusUpdateEvent;
    expect(initial.status.state).toBe(TASK_STATE.IN_PROGRESS);
    expect(initial.final).toBe(false);

    const final = resubFrames[resubFrames.length - 1]?.json
      .data as TaskStatusUpdateEvent;
    expect(final.status.state).toBe(TASK_STATE.COMPLETED);
    expect(final.final).toBe(true);
  });

  it('fans out the same stream to multiple concurrent resubscribers', async () => {
    const storage = new InMemoryTaskStorage();
    const registry = new TaskEventBusRegistry();

    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });

    const executor: StreamingTaskExecutor = async function* () {
      await gate;
      yield {
        type: 'delta',
        message: {
          messageId: 'd-1',
          role: 'ROLE_AGENT',
          parts: [{ text: 'shared' }],
        },
      };
    };

    const server = createA2AServer({ card: makeCard() });
    server.registerStreamingMethod(
      MESSAGE_STREAM_METHOD,
      createMessageStreamHandler({
        storage,
        executor,
        idGenerator: () => 'task-1',
        env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
        heartbeatMs: 0,
        eventBusRegistry: registry,
      })
    );
    server.registerStreamingMethod(
      TASK_RESUBSCRIBE_METHOD,
      createTaskResubscribeHandler({
        storage,
        eventBusRegistry: registry,
        heartbeatMs: 0,
      })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const producerRes = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: MESSAGE_STREAM_METHOD,
        params: {
          message: {
            messageId: 'user-1',
            role: 'ROLE_USER',
            contextId: 'ctx-1',
            parts: [{ text: 'hello' }],
          },
        },
      }),
    });
    expect(producerRes.status).toBe(200);

    await waitForBusStatus(registry, 'task-1');

    const subA = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 2,
        method: TASK_RESUBSCRIBE_METHOD,
        params: { taskId: 'task-1' },
      }),
    });
    const subB = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 3,
        method: TASK_RESUBSCRIBE_METHOD,
        params: { taskId: 'task-1' },
      }),
    });
    expect(subA.status).toBe(200);
    expect(subB.status).toBe(200);

    resolveGate?.();

    const [framesA, framesB] = await Promise.all([
      readFrames(subA),
      readFrames(subB),
    ]);

    expect(framesA.map((f) => f.json.type)).toEqual(
      framesB.map((f) => f.json.type)
    );

    // Both must see at least: initial replay status, the shared delta, final
    // status.
    expect(framesA.length).toBeGreaterThanOrEqual(3);
    expect(framesA[framesA.length - 1]?.json.type).toBe(
      AGENT_EVENT_TYPE.TASK_STATUS_CHANGED
    );

    const lastA = framesA[framesA.length - 1]?.json
      .data as TaskStatusUpdateEvent;
    const lastB = framesB[framesB.length - 1]?.json
      .data as TaskStatusUpdateEvent;
    expect(lastA.final).toBe(true);
    expect(lastB.final).toBe(true);
    expect(lastA.status.state).toBe(TASK_STATE.COMPLETED);
    expect(lastB.status.state).toBe(TASK_STATE.COMPLETED);

    // After the producing stream ends, the bus should be removed from the
    // registry.
    await producerRes.body?.cancel();
    expect(registry.has('task-1')).toBe(false);
  });

  it('emits a single final status frame and closes when the task is already terminal', async () => {
    const storage = new InMemoryTaskStorage();
    const registry = new TaskEventBusRegistry();
    seedTaskInState(storage, 'task-done', TASK_STATE.COMPLETED);

    const server = createA2AServer({ card: makeCard() });
    server.registerStreamingMethod(
      TASK_RESUBSCRIBE_METHOD,
      createTaskResubscribeHandler({
        storage,
        eventBusRegistry: registry,
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
        method: TASK_RESUBSCRIBE_METHOD,
        params: { taskId: 'task-done' },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);

    const frames = await readFrames(res);
    expect(frames).toHaveLength(1);
    const data = frames[0]?.json.data as TaskStatusUpdateEvent;
    expect(data.status.state).toBe(TASK_STATE.COMPLETED);
    expect(data.final).toBe(true);
  });
});

async function collectFrames(
  readable: ReadableStream<Uint8Array>
): Promise<Frame[]> {
  const reader = readable.getReader();
  let buffer = '';
  const frames: Frame[] = [];
  try {
    while (true) {
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
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

async function waitForBusStatus(
  registry: TaskEventBusRegistry,
  taskId: string,
  timeoutMs = 2000
): Promise<TaskEventBus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bus = registry.get(taskId);
    if (bus !== undefined && bus.lastStatus !== undefined) {
      return bus;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `bus for task ${taskId} did not publish a status within ${timeoutMs}ms`
  );
}
