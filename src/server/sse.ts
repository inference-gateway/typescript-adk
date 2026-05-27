import {
  CLOUDEVENTS_SPEC_VERSION,
  createCloudEvent,
  type CloudEvent,
  type CreateCloudEventInput,
} from './cloudevents.js';

/**
 * Default heartbeat interval (30 s). Matches the recommendation in the issue
 * and is comfortably below the typical idle-timeout window of intermediate
 * proxies. Set {@link SSEStreamOptions.heartbeatMs} to `0` to disable.
 */
export const DEFAULT_SSE_HEARTBEAT_MS = 30_000;

/** SSE response Content-Type. */
export const SSE_CONTENT_TYPE = 'text/event-stream';

/**
 * Response headers commonly applied to an SSE endpoint. `X-Accel-Buffering: no`
 * disables proxy buffering on nginx so events flush incrementally; the others
 * are the SSE conventional defaults.
 *
 * The object is frozen and re-usable: callers can spread it into a
 * `Response` / `Hono` / `Fastify` headers payload without worrying about
 * accidental mutation.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': SSE_CONTENT_TYPE,
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});

export interface SSEStreamOptions {
  /**
   * Interval in milliseconds between heartbeat comment frames. Defaults to
   * {@link DEFAULT_SSE_HEARTBEAT_MS}; pass `0` to disable heartbeats entirely
   * (useful in tests that want full control over the byte stream).
   */
  readonly heartbeatMs?: number;
  /**
   * AbortSignal that, when aborted, closes the stream. Suitable for plumbing
   * client-disconnect signals (e.g., `c.req.raw.signal` in Hono) so that any
   * background work feeding the stream can unwind.
   */
  readonly signal?: AbortSignal;
  /**
   * Override the heartbeat comment payload (the text after the leading `:`).
   * Default is the literal `heartbeat`. Newlines are not permitted.
   */
  readonly heartbeatComment?: string;
}

const HEARTBEAT_COMMENT_DEFAULT = 'heartbeat';

const textEncoder = new TextEncoder();

function isLikelyCloudEvent(value: unknown): value is CloudEvent {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    obj['specversion'] === CLOUDEVENTS_SPEC_VERSION &&
    typeof obj['id'] === 'string' &&
    typeof obj['source'] === 'string' &&
    typeof obj['type'] === 'string'
  );
}

/**
 * Server-Sent Events writer backed by a Web `ReadableStream<Uint8Array>`.
 *
 * Produces the canonical SSE wire format - `data: <json>\n\n` per event,
 * `: <comment>\n\n` per heartbeat - so the {@link readable} stream can be
 * handed directly to Hono (`return c.body(writer.readable, 200, SSE_HEADERS)`),
 * Fastify (`reply.send(writer.readable)`), or a `Response` constructor.
 *
 * Each {@link emit} call serialises a CloudEvents v1.0 envelope (either built
 * inline via {@link createCloudEvent} or supplied pre-built via
 * {@link emitCloudEvent}) and enqueues a single frame, so frames are not
 * buffered beyond a single `controller.enqueue` call. Heartbeats are emitted
 * on a `setInterval` while the stream is open and cleared on close.
 *
 * Lifecycle: the stream closes when any of the following happens:
 *  - {@link close} is called explicitly,
 *  - the `signal` passed to {@link SSEStreamOptions.signal} is aborted,
 *  - the consumer cancels the {@link readable} (e.g., the HTTP client
 *    disconnects and the runtime tears down the body stream).
 *
 * After close, {@link emit} / {@link emitCloudEvent} / {@link comment} are
 * no-ops, so a producer that races a `close()` can safely continue calling
 * them.
 */
export class SSEStreamWriter {
  /**
   * The Web ReadableStream of SSE frames. Hand this to a framework's response
   * body slot. Each chunk is a UTF-8 encoded `Uint8Array` containing one
   * complete frame (terminated by `\n\n`).
   */
  readonly readable: ReadableStream<Uint8Array>;

  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private isClosed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly signal: AbortSignal | undefined;
  private onAbort: (() => void) | undefined;
  private readonly heartbeatMs: number;
  private readonly heartbeatComment: string;

  constructor(options: SSEStreamOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
    if (
      !Number.isFinite(this.heartbeatMs) ||
      this.heartbeatMs < 0 ||
      !Number.isInteger(this.heartbeatMs)
    ) {
      throw new TypeError(
        'heartbeatMs must be a non-negative integer (0 disables heartbeats)'
      );
    }

    const heartbeatComment =
      options.heartbeatComment ?? HEARTBEAT_COMMENT_DEFAULT;
    if (heartbeatComment.includes('\n') || heartbeatComment.includes('\r')) {
      throw new TypeError('heartbeatComment must not contain newlines');
    }
    this.heartbeatComment = heartbeatComment;

    this.signal = options.signal;

    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        this.attachSignal();
        this.startHeartbeat();
      },
      cancel: () => {
        this.handleConsumerCancel();
      },
    });
  }

  /** Whether the stream has been closed (either explicitly or via cancel/abort). */
  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Build a CloudEvents envelope from `input` and write it as a single
   * `data: ...\n\n` frame. Returns the envelope that was emitted so callers
   * can introspect the generated id / time / etc. for logging or tracing.
   *
   * No-op (returns `undefined`) when the stream is already closed.
   */
  emit<T>(input: CreateCloudEventInput<T>): CloudEvent<T> | undefined {
    if (this.isClosed) {
      return undefined;
    }
    const event = createCloudEvent(input);
    this.writeFrame(`data: ${JSON.stringify(event)}\n\n`);
    return event;
  }

  /**
   * Write a pre-built CloudEvents envelope as a single `data: ...\n\n` frame.
   * Use this when constructing the envelope ahead of time (e.g., to share an
   * id with another out-of-band system) or when forwarding an envelope
   * received from another producer.
   *
   * No-op when the stream is already closed.
   */
  emitCloudEvent(event: CloudEvent): void {
    if (this.isClosed) {
      return;
    }
    if (!isLikelyCloudEvent(event)) {
      throw new TypeError(
        'emitCloudEvent expected a CloudEvents v1.0 envelope (specversion "1.0" with id/source/type)'
      );
    }
    this.writeFrame(`data: ${JSON.stringify(event)}\n\n`);
  }

  /**
   * Write a free-form SSE comment frame (`: <text>\n\n`). Comment frames keep
   * the connection warm without delivering any application-level payload, and
   * are the primitive used internally by the heartbeat scheduler.
   *
   * Newlines in `text` are rejected because a comment frame is a single line.
   * No-op when the stream is already closed.
   */
  comment(text: string): void {
    if (this.isClosed) {
      return;
    }
    if (text.includes('\n') || text.includes('\r')) {
      throw new TypeError('SSE comment text must not contain newlines');
    }
    this.writeFrame(`: ${text}\n\n`);
  }

  /**
   * Close the stream. Cancels the heartbeat timer, detaches the abort
   * listener, and closes the underlying ReadableStream controller. Safe to
   * call multiple times.
   */
  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.cleanup();
    if (this.controller !== null) {
      try {
        this.controller.close();
      } catch {
        // Controller was already closed by the runtime (e.g., consumer cancel).
      }
      this.controller = null;
    }
  }

  private writeFrame(frame: string): void {
    if (this.controller === null) {
      return;
    }
    try {
      this.controller.enqueue(textEncoder.encode(frame));
    } catch {
      // The controller has been torn down by the runtime; treat as a close.
      this.isClosed = true;
      this.cleanup();
      this.controller = null;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatMs === 0 || this.isClosed) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      this.writeFrame(`: ${this.heartbeatComment}\n\n`);
    }, this.heartbeatMs);
    // Don't keep the Node event loop alive solely for heartbeats.
    const timer = this.heartbeatTimer as { unref?: () => void };
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  private attachSignal(): void {
    if (this.signal === undefined) {
      return;
    }
    if (this.signal.aborted) {
      // Close on the next microtask so that a constructor caller can still
      // attach a listener to `readable` before the close happens.
      queueMicrotask(() => this.close());
      return;
    }
    this.onAbort = (): void => this.close();
    this.signal.addEventListener('abort', this.onAbort, { once: true });
  }

  private handleConsumerCancel(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.cleanup();
    this.controller = null;
  }

  private cleanup(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.signal !== undefined && this.onAbort !== undefined) {
      this.signal.removeEventListener('abort', this.onAbort);
      this.onAbort = undefined;
    }
  }
}
