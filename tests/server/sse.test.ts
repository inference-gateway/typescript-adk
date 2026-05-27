import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_EVENT_TYPE,
  createCloudEvent,
} from '../../src/server/cloudevents.js';
import {
  DEFAULT_SSE_HEARTBEAT_MS,
  SSE_CONTENT_TYPE,
  SSE_HEADERS,
  SSEStreamWriter,
} from '../../src/server/sse.js';

const decoder = new TextDecoder();

/**
 * Drain the next chunk from a reader and decode it as a UTF-8 string. Returns
 * `null` when the stream has ended (so callers can loop until then).
 */
async function nextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<string | null> {
  const { value, done } = await reader.read();
  if (done) {
    return null;
  }
  return decoder.decode(value);
}

/**
 * Drain the entire stream into a single concatenated string. Used to assert
 * the full event sequence after the writer has been closed.
 */
async function drainAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let acc = '';
  while (true) {
    const chunk = await nextChunk(reader);
    if (chunk === null) {
      break;
    }
    acc += chunk;
  }
  reader.releaseLock();
  return acc;
}

describe('SSE response headers', () => {
  it('publishes the conventional SSE headers and content type', () => {
    expect(SSE_CONTENT_TYPE).toBe('text/event-stream');
    expect(SSE_HEADERS).toMatchObject({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  });

  it('exposes a 30 s default heartbeat interval', () => {
    expect(DEFAULT_SSE_HEARTBEAT_MS).toBe(30_000);
  });

  it('freezes the headers object so callers cannot mutate the shared default', () => {
    expect(Object.isFrozen(SSE_HEADERS)).toBe(true);
  });
});

describe('SSEStreamWriter envelope wrapping', () => {
  it('wraps emit() input in a CloudEvents v1.0 data frame', async () => {
    const writer = new SSEStreamWriter({ heartbeatMs: 0 });
    writer.emit({
      id: 'evt-1',
      type: AGENT_EVENT_TYPE.DELTA,
      data: { text: 'hello' },
      time: '2026-05-26T12:00:00.000Z',
    });
    writer.close();

    const text = await drainAll(writer.readable);
    expect(text.startsWith('data: ')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(true);

    const json = JSON.parse(text.slice('data: '.length, -2)) as Record<
      string,
      unknown
    >;
    expect(json).toEqual({
      specversion: '1.0',
      id: 'evt-1',
      source: 'adk/agent',
      type: 'adk.agent.delta',
      time: '2026-05-26T12:00:00.000Z',
      datacontenttype: 'application/json',
      data: { text: 'hello' },
    });
  });

  it('returns the CloudEvents envelope from emit() for tracing/logging', () => {
    const writer = new SSEStreamWriter({ heartbeatMs: 0 });
    const event = writer.emit({
      id: 'evt-1',
      type: AGENT_EVENT_TYPE.TOOL_STARTED,
      data: { toolCallId: 'call-abc' },
    });
    writer.close();

    expect(event).toBeDefined();
    expect(event?.id).toBe('evt-1');
    expect(event?.type).toBe('adk.agent.tool.started');
  });

  it('preserves the order of multiple emitted events', async () => {
    const writer = new SSEStreamWriter({ heartbeatMs: 0 });
    writer.emit({
      id: 'evt-1',
      type: AGENT_EVENT_TYPE.DELTA,
      data: { text: 'one' },
      time: '2026-05-26T12:00:00.000Z',
    });
    writer.emit({
      id: 'evt-2',
      type: AGENT_EVENT_TYPE.DELTA,
      data: { text: 'two' },
      time: '2026-05-26T12:00:01.000Z',
    });
    writer.emit({
      id: 'evt-3',
      type: AGENT_EVENT_TYPE.ITERATION_COMPLETED,
      data: { iteration: 1 },
      time: '2026-05-26T12:00:02.000Z',
    });
    writer.close();

    const text = await drainAll(writer.readable);
    const frames = text.split('\n\n').filter((f) => f.length > 0);
    expect(frames).toHaveLength(3);

    const ids = frames.map((frame) => {
      const json = JSON.parse(frame.slice('data: '.length)) as { id: string };
      return json.id;
    });
    expect(ids).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('emitCloudEvent forwards a pre-built envelope verbatim', async () => {
    const event = createCloudEvent({
      id: 'evt-pre',
      type: AGENT_EVENT_TYPE.TOOL_RESULT,
      data: { toolCallId: 'call-1', result: { ok: true } },
      time: '2026-05-26T12:00:00.000Z',
    });

    const writer = new SSEStreamWriter({ heartbeatMs: 0 });
    writer.emitCloudEvent(event);
    writer.close();

    const text = await drainAll(writer.readable);
    const json = JSON.parse(text.slice('data: '.length, -2)) as {
      id: string;
      data: unknown;
    };
    expect(json.id).toBe('evt-pre');
    expect(json.data).toEqual({ toolCallId: 'call-1', result: { ok: true } });
  });

  it('emitCloudEvent rejects non-envelope objects', () => {
    const writer = new SSEStreamWriter({ heartbeatMs: 0 });
    expect(() =>
      writer.emitCloudEvent({
        specversion: '2.0',
      } as unknown as Parameters<typeof writer.emitCloudEvent>[0])
    ).toThrow(/CloudEvents v1\.0/);
    writer.close();
  });

  it('flushes a separate chunk per emit (no buffering across events)', async () => {
    const writer = new SSEStreamWriter({ heartbeatMs: 0 });
    const reader = writer.readable.getReader();

    writer.emit({
      id: 'evt-1',
      type: AGENT_EVENT_TYPE.DELTA,
      data: { text: 'one' },
      time: '2026-05-26T12:00:00.000Z',
    });
    const first = await nextChunk(reader);
    expect(first).not.toBeNull();
    expect(
      JSON.parse((first as string).slice('data: '.length, -2))
    ).toMatchObject({
      id: 'evt-1',
    });

    writer.emit({
      id: 'evt-2',
      type: AGENT_EVENT_TYPE.DELTA,
      data: { text: 'two' },
      time: '2026-05-26T12:00:01.000Z',
    });
    const second = await nextChunk(reader);
    expect(second).not.toBeNull();
    expect(
      JSON.parse((second as string).slice('data: '.length, -2))
    ).toMatchObject({ id: 'evt-2' });

    writer.close();
    reader.releaseLock();
  });

  it('emits all ten adk.agent.* event types in the canonical order', async () => {
    const writer = new SSEStreamWriter({ heartbeatMs: 0 });
    const types = [
      AGENT_EVENT_TYPE.DELTA,
      AGENT_EVENT_TYPE.ITERATION_COMPLETED,
      AGENT_EVENT_TYPE.TOOL_STARTED,
      AGENT_EVENT_TYPE.TOOL_COMPLETED,
      AGENT_EVENT_TYPE.TOOL_FAILED,
      AGENT_EVENT_TYPE.TOOL_RESULT,
      AGENT_EVENT_TYPE.INPUT_REQUIRED,
      AGENT_EVENT_TYPE.TASK_STATUS_CHANGED,
      AGENT_EVENT_TYPE.TASK_INTERRUPTED,
      AGENT_EVENT_TYPE.STREAM_FAILED,
    ];
    for (const [i, type] of types.entries()) {
      writer.emit({
        id: `evt-${i}`,
        type,
        data: null,
        time: '2026-05-26T12:00:00.000Z',
      });
    }
    writer.close();

    const text = await drainAll(writer.readable);
    const emitted = text
      .split('\n\n')
      .filter((f) => f.length > 0)
      .map(
        (frame) =>
          (JSON.parse(frame.slice('data: '.length)) as { type: string }).type
      );
    expect(emitted).toEqual(types);
  });
});

describe('SSEStreamWriter comments and heartbeats', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('comment() writes a free-form colon-prefixed line', async () => {
    const writer = new SSEStreamWriter({ heartbeatMs: 0 });
    writer.comment('hello world');
    writer.close();

    const text = await drainAll(writer.readable);
    expect(text).toBe(': hello world\n\n');
  });

  it('comment() rejects newlines in the payload', () => {
    const writer = new SSEStreamWriter({ heartbeatMs: 0 });
    expect(() => writer.comment('line1\nline2')).toThrow(/newlines/);
    writer.close();
  });

  it('emits a heartbeat comment frame on the configured interval', async () => {
    const writer = new SSEStreamWriter({ heartbeatMs: 100 });
    const reader = writer.readable.getReader();

    await vi.advanceTimersByTimeAsync(100);
    const first = await nextChunk(reader);
    expect(first).toBe(': heartbeat\n\n');

    await vi.advanceTimersByTimeAsync(100);
    const second = await nextChunk(reader);
    expect(second).toBe(': heartbeat\n\n');

    writer.close();
    reader.releaseLock();
  });

  it('uses a custom heartbeat comment when supplied', async () => {
    const writer = new SSEStreamWriter({
      heartbeatMs: 100,
      heartbeatComment: 'keepalive',
    });
    const reader = writer.readable.getReader();

    await vi.advanceTimersByTimeAsync(100);
    const frame = await nextChunk(reader);
    expect(frame).toBe(': keepalive\n\n');

    writer.close();
    reader.releaseLock();
  });

  it('does not emit heartbeats when heartbeatMs is 0', async () => {
    const writer = new SSEStreamWriter({ heartbeatMs: 0 });
    const reader = writer.readable.getReader();

    await vi.advanceTimersByTimeAsync(1_000_000);
    writer.close();
    const next = await nextChunk(reader);
    expect(next).toBeNull();
    reader.releaseLock();
  });

  it('clears the heartbeat timer on close', async () => {
    const writer = new SSEStreamWriter({ heartbeatMs: 100 });
    const reader = writer.readable.getReader();

    await vi.advanceTimersByTimeAsync(100);
    const first = await nextChunk(reader);
    expect(first).toBe(': heartbeat\n\n');

    writer.close();
    // Advancing past several intervals must not produce more frames; the
    // reader should signal completion.
    await vi.advanceTimersByTimeAsync(1_000);
    const next = await nextChunk(reader);
    expect(next).toBeNull();
    reader.releaseLock();
  });

  it('rejects a negative or non-integer heartbeat interval', () => {
    expect(() => new SSEStreamWriter({ heartbeatMs: -1 })).toThrow(
      /non-negative/
    );
    expect(() => new SSEStreamWriter({ heartbeatMs: 1.5 })).toThrow(
      /non-negative/
    );
  });

  it('rejects a heartbeat comment containing newlines', () => {
    expect(
      () => new SSEStreamWriter({ heartbeatComment: 'line1\nline2' })
    ).toThrow(/newlines/);
  });
});

describe('SSEStreamWriter cancellation', () => {
  it('closes the stream when the AbortSignal aborts', async () => {
    const controller = new AbortController();
    const writer = new SSEStreamWriter({
      heartbeatMs: 0,
      signal: controller.signal,
    });

    writer.emit({
      id: 'evt-1',
      type: AGENT_EVENT_TYPE.DELTA,
      data: { text: 'before abort' },
      time: '2026-05-26T12:00:00.000Z',
    });

    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(writer.closed).toBe(true);

    const text = await drainAll(writer.readable);
    expect(text.includes('"before abort"')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(true);
  });

  it('drops further emits after the signal has aborted', async () => {
    const controller = new AbortController();
    const writer = new SSEStreamWriter({
      heartbeatMs: 0,
      signal: controller.signal,
    });

    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const result = writer.emit({
      type: AGENT_EVENT_TYPE.DELTA,
      data: { text: 'dropped' },
    });
    expect(result).toBeUndefined();

    const text = await drainAll(writer.readable);
    expect(text).toBe('');
  });

  it('closes immediately when the signal is already aborted at construction', async () => {
    const controller = new AbortController();
    controller.abort();

    const writer = new SSEStreamWriter({
      heartbeatMs: 0,
      signal: controller.signal,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writer.closed).toBe(true);

    const text = await drainAll(writer.readable);
    expect(text).toBe('');
  });

  it('handles consumer-side cancel without throwing', async () => {
    const writer = new SSEStreamWriter({ heartbeatMs: 0 });
    writer.emit({
      id: 'evt-1',
      type: AGENT_EVENT_TYPE.DELTA,
      data: { text: 'one' },
      time: '2026-05-26T12:00:00.000Z',
    });
    await writer.readable.cancel();

    expect(writer.closed).toBe(true);
    expect(() =>
      writer.emit({
        type: AGENT_EVENT_TYPE.DELTA,
        data: { text: 'two' },
      })
    ).not.toThrow();
  });

  it('treats close() as idempotent', () => {
    const writer = new SSEStreamWriter({ heartbeatMs: 0 });
    writer.close();
    expect(() => writer.close()).not.toThrow();
    expect(writer.closed).toBe(true);
  });
});
