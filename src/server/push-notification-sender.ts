import pkg from '../../package.json' with { type: 'json' };
import type {
  AuthenticationInfo,
  PushNotificationConfig,
  Task,
  TaskState,
} from '../types/generated/a2a.js';
import type { Logger } from './server-builder.js';

/**
 * `fetch`-compatible function signature accepted by the sender. Mirrors the
 * shape used by {@link A2AClient} so the same fakes can be reused across
 * tests. Defaults to `globalThis.fetch` (undici in Node 22+).
 */
export type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

/**
 * Default per-attempt HTTP timeout, in milliseconds. Each retry attempt gets
 * its own budget - the timeout is not shared across attempts.
 */
export const DEFAULT_PUSH_NOTIFICATION_TIMEOUT_MS = 30_000;

/**
 * Default concurrency cap for {@link HTTPPushNotificationSender.deliverTaskUpdate}
 * fan-out. Set high enough that small fan-outs run fully in parallel, low
 * enough that a misconfigured task with hundreds of webhooks does not
 * stampede the local egress.
 */
export const DEFAULT_PUSH_NOTIFICATION_CONCURRENCY = 8;

/**
 * Retry policy used by {@link HTTPPushNotificationSender} for transient HTTP
 * failures. Mirrors the shape of the client's `RetryConfig`, but is kept
 * private to the sender so the two surfaces can drift independently.
 */
export interface PushNotificationRetryConfig {
  /** Maximum retry attempts after the initial try. `0` disables retries. */
  readonly maxRetries: number;
  /** Base delay before the first retry, in milliseconds. */
  readonly initialDelayMs: number;
  /** Upper bound on the per-attempt delay, in milliseconds. */
  readonly maxDelayMs: number;
}

/**
 * Default retry policy. Three attempts after the initial try with exponential
 * backoff, capped at 30s. Matches the issue spec.
 */
export const DEFAULT_PUSH_NOTIFICATION_RETRY_CONFIG: PushNotificationRetryConfig =
  Object.freeze({
    maxRetries: 3,
    initialDelayMs: 500,
    maxDelayMs: 30_000,
  });

/**
 * Wire-format payload posted to each registered webhook URL on a task state
 * transition. Identical field set to the Go ADK's `TaskUpdateNotification`
 * (`adk/server/push_notification_sender.go`).
 *
 * `timestamp` is RFC 3339 (ISO 8601 with a `Z` suffix). The full `task`
 * snapshot is included so receivers do not need a separate `tasks/get` to
 * reconstruct context.
 */
export interface TaskUpdateNotification {
  readonly type: 'task_update';
  readonly taskId: string;
  readonly state: TaskState;
  readonly timestamp: string;
  readonly task: Task;
}

export interface HTTPPushNotificationSenderConfig {
  /**
   * `fetch` implementation. Defaults to `globalThis.fetch` (undici in
   * Node 22+). Inject for tests or to plug in a proxy/agent.
   */
  readonly fetch?: FetchLike;
  /**
   * Structural logger. Defaults to a no-op. Failed deliveries are logged at
   * `warn` so they do not surface as application errors.
   */
  readonly logger?: Logger;
  /**
   * Value for the outbound `User-Agent` header. Defaults to a string derived
   * from this package's name and version.
   */
  readonly userAgent?: string;
  /**
   * Per-attempt timeout in milliseconds. Defaults to
   * {@link DEFAULT_PUSH_NOTIFICATION_TIMEOUT_MS}. Set to `0` to disable.
   */
  readonly timeoutMs?: number;
  /**
   * Retry policy. Pass partial overrides to tune individual fields, or `false`
   * to disable retries entirely. Defaults to
   * {@link DEFAULT_PUSH_NOTIFICATION_RETRY_CONFIG}.
   */
  readonly retry?: Partial<PushNotificationRetryConfig> | false;
}

/**
 * Options accepted by every `send*` / `deliver*` method on
 * {@link HTTPPushNotificationSender}.
 */
export interface SendTaskUpdateOptions {
  /** Caller-supplied abort signal. Aborting cancels in-flight requests. */
  readonly signal?: AbortSignal;
}

/**
 * Options accepted by {@link HTTPPushNotificationSender.deliverTaskUpdate}.
 */
export interface DeliverTaskUpdateOptions extends SendTaskUpdateOptions {
  /**
   * Maximum number of concurrent in-flight POSTs. Defaults to
   * {@link DEFAULT_PUSH_NOTIFICATION_CONCURRENCY}. Must be `>= 1`.
   */
  readonly concurrency?: number;
}

/**
 * Result of a single delivery attempt, returned by
 * {@link HTTPPushNotificationSender.deliverTaskUpdate}. `ok: true` means the
 * webhook accepted the POST with a 2xx (after any retries). `ok: false`
 * means the delivery failed permanently - the failure has already been
 * logged via the configured logger.
 */
export type DeliveryResult =
  | {
      readonly ok: true;
      readonly configId: string | undefined;
      readonly url: string;
    }
  | {
      readonly ok: false;
      readonly configId: string | undefined;
      readonly url: string;
      readonly error: PushNotificationSendError;
    };

/**
 * Sender that posts task lifecycle notifications to HTTP webhooks.
 *
 * Implementations decouple state-transition emitters from the wire format
 * and transport, mirroring the Go ADK's `PushNotificationSender` interface
 * (`adk/server/push_notification_sender.go`). The bundled
 * {@link HTTPPushNotificationSender} covers the common case; downstream
 * consumers can supply alternative implementations (e.g., enqueueing to a
 * durable queue) without touching the lifecycle code.
 */
export interface PushNotificationSender {
  /**
   * Post a single `task_update` notification to `config.url`. Resolves on
   * any 2xx response (after any configured retries) and rejects with a
   * {@link PushNotificationSendError} on permanent failure.
   */
  sendTaskUpdate(
    config: PushNotificationConfig,
    task: Task,
    options?: SendTaskUpdateOptions
  ): Promise<void>;
}

/**
 * Permanent delivery failure surfaced by
 * {@link HTTPPushNotificationSender.sendTaskUpdate}. Wraps the underlying
 * cause (a network error, a non-2xx HTTP response, a timeout, or an abort)
 * with enough context (URL, last status, attempts) for operators to
 * triage.
 */
export class PushNotificationSendError extends Error {
  override readonly name = 'PushNotificationSendError';
  readonly url: string;
  readonly attempts: number;
  readonly status: number | undefined;

  constructor(
    message: string,
    url: string,
    attempts: number,
    status: number | undefined,
    cause?: unknown
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.url = url;
    this.attempts = attempts;
    this.status = status;
  }
}

/**
 * HTTP webhook implementation of {@link PushNotificationSender}.
 *
 * Posts JSON-encoded {@link TaskUpdateNotification} payloads to the URL on
 * each {@link PushNotificationConfig}, attaches `Authorization: Bearer <token>`
 * when `config.token` is set (and similar via `config.authentication`), and
 * retries transient HTTP failures with exponential backoff. Failed
 * deliveries surfaced via {@link deliverTaskUpdate} are logged but never
 * surface as exceptions, so an unreachable webhook cannot fail the task.
 *
 * Mirrors `HTTPPushNotificationSender` in the Go ADK
 * (`adk/server/push_notification_sender.go`).
 */
export class HTTPPushNotificationSender implements PushNotificationSender {
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly retryConfig: PushNotificationRetryConfig | null;

  constructor(config: HTTPPushNotificationSenderConfig = {}) {
    const resolvedFetch = config.fetch ?? globalThis.fetch;
    if (typeof resolvedFetch !== 'function') {
      throw new TypeError(
        'no fetch implementation available; pass `fetch` in config'
      );
    }
    this.fetchImpl = resolvedFetch;
    this.logger = config.logger ?? NOOP_LOGGER;
    this.userAgent = config.userAgent ?? `${pkg.name}/${pkg.version}`;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_PUSH_NOTIFICATION_TIMEOUT_MS;

    if (config.retry === false) {
      this.retryConfig = null;
    } else {
      this.retryConfig = {
        ...DEFAULT_PUSH_NOTIFICATION_RETRY_CONFIG,
        ...(config.retry ?? {}),
      };
    }
  }

  /**
   * Post a single `task_update` notification to `config.url`. Returns when
   * the webhook accepts the POST with a 2xx. Throws
   * {@link PushNotificationSendError} after exhausting retries on
   * transient failures, or immediately on a non-retryable failure (non-2xx
   * outside 5xx/429, or caller abort).
   */
  async sendTaskUpdate(
    config: PushNotificationConfig,
    task: Task,
    options: SendTaskUpdateOptions = {}
  ): Promise<void> {
    const payload: TaskUpdateNotification = {
      type: 'task_update',
      taskId: task.id,
      state: task.status.state,
      timestamp: new Date().toISOString(),
      task,
    };
    const body = JSON.stringify(payload);
    const headers = this.buildHeaders(config);
    const maxRetries = this.retryConfig?.maxRetries ?? 0;
    let attempt: number;
    let lastError: unknown;
    let lastStatus: number | undefined;

    for (attempt = 0; attempt <= maxRetries; attempt++) {
      if (options.signal?.aborted === true) {
        throw new PushNotificationSendError(
          'push notification delivery aborted',
          config.url,
          attempt,
          lastStatus,
          options.signal.reason
        );
      }
      try {
        const response = await this.postOnce(
          config.url,
          body,
          headers,
          options.signal
        );
        if (response.status >= 200 && response.status < 300) {
          this.logger.info('push notification sent', {
            taskId: task.id,
            url: config.url,
            state: task.status.state,
            statusCode: response.status,
            attempts: attempt + 1,
          });
          return;
        }
        lastStatus = response.status;
        lastError = new PushNotificationSendError(
          `push notification webhook returned status ${response.status}`,
          config.url,
          attempt + 1,
          response.status
        );
        if (!isRetryableStatus(response.status)) {
          throw lastError;
        }
      } catch (err) {
        if (err instanceof PushNotificationSendError) {
          // Non-retryable status path above; rethrow without further retries.
          throw err;
        }
        if (isAbortError(err) && isAborted(options.signal)) {
          throw new PushNotificationSendError(
            'push notification delivery aborted',
            config.url,
            attempt + 1,
            lastStatus,
            err
          );
        }
        lastError = err;
      }

      if (attempt < maxRetries) {
        const delay = computeBackoffDelay(attempt, this.retryConfig);
        await sleep(delay, options.signal);
      }
    }

    throw new PushNotificationSendError(
      `push notification delivery failed after ${attempt} attempts`,
      config.url,
      attempt,
      lastStatus,
      lastError
    );
  }

  /**
   * Fan-out variant: deliver the same task update to every config in
   * `configs`, capped at {@link DeliverTaskUpdateOptions.concurrency}
   * in-flight POSTs. Never throws on per-config failure - failed
   * deliveries are logged via the configured logger and surfaced in the
   * returned {@link DeliveryResult} array.
   *
   * Use this from a state-transition listener so a slow or broken webhook
   * cannot fail the task that triggered the notification.
   */
  async deliverTaskUpdate(
    configs: readonly PushNotificationConfig[],
    task: Task,
    options: DeliverTaskUpdateOptions = {}
  ): Promise<DeliveryResult[]> {
    if (configs.length === 0) {
      return [];
    }
    const concurrency = Math.max(
      1,
      options.concurrency ?? DEFAULT_PUSH_NOTIFICATION_CONCURRENCY
    );
    const results: DeliveryResult[] = new Array<DeliveryResult>(configs.length);
    let next = 0;

    const sendOptions: SendTaskUpdateOptions =
      options.signal !== undefined ? { signal: options.signal } : {};

    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = next++;
        if (idx >= configs.length) {
          return;
        }
        const config = configs[idx]!;
        try {
          await this.sendTaskUpdate(config, task, sendOptions);
          results[idx] = {
            ok: true,
            configId: config.id,
            url: config.url,
          };
        } catch (err) {
          const error =
            err instanceof PushNotificationSendError
              ? err
              : new PushNotificationSendError(
                  err instanceof Error ? err.message : 'unknown delivery error',
                  config.url,
                  0,
                  undefined,
                  err
                );
          this.logger.warn('push notification delivery failed', {
            taskId: task.id,
            url: config.url,
            configId: config.id,
            attempts: error.attempts,
            status: error.status,
            error: error.message,
          });
          results[idx] = {
            ok: false,
            configId: config.id,
            url: config.url,
            error,
          };
        }
      }
    };

    const workerCount = Math.min(concurrency, configs.length);
    const workers = new Array<Promise<void>>(workerCount);
    for (let i = 0; i < workerCount; i++) {
      workers[i] = worker();
    }
    await Promise.all(workers);
    return results;
  }

  private async postOnce(
    url: string,
    body: string,
    headers: Record<string, string>,
    userSignal: AbortSignal | undefined
  ): Promise<Response> {
    const timeoutSignal =
      this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined;
    const signal = composeSignals(userSignal, timeoutSignal);

    const init: RequestInit = {
      method: 'POST',
      headers,
      body,
    };
    if (signal !== undefined) {
      (init as { signal: AbortSignal }).signal = signal;
    }

    return await this.fetchImpl(url, init);
  }

  private buildHeaders(config: PushNotificationConfig): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    };
    const auth = resolveAuthorization(config);
    if (auth !== undefined) {
      headers['Authorization'] = auth;
    }
    return headers;
  }
}

function resolveAuthorization(
  config: PushNotificationConfig
): string | undefined {
  let header: string | undefined;
  if (typeof config.token === 'string' && config.token.length > 0) {
    header = `Bearer ${config.token}`;
  }
  const auth = config.authentication;
  if (auth !== undefined) {
    const fromScheme = authorizationFromSchemes(auth);
    if (fromScheme !== undefined) {
      header = fromScheme;
    }
  }
  return header;
}

function authorizationFromSchemes(
  auth: AuthenticationInfo
): string | undefined {
  const credentials = auth.credentials;
  if (typeof credentials !== 'string' || credentials.length === 0) {
    return undefined;
  }
  for (const scheme of auth.schemes) {
    const normalised = scheme.toLowerCase();
    if (normalised === 'bearer') {
      return `Bearer ${credentials}`;
    }
    if (normalised === 'basic') {
      return `Basic ${credentials}`;
    }
  }
  return undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === 'AbortError' || err.name === 'TimeoutError';
  }
  return false;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function computeBackoffDelay(
  attempt: number,
  config: PushNotificationRetryConfig | null
): number {
  if (config === null) {
    return 0;
  }
  return Math.min(config.initialDelayMs * 2 ** attempt, config.maxDelayMs);
}

function composeSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  return AbortSignal.any(defined);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signalReasonAsError(signal));
      return;
    }
    const timer = setTimeout(() => {
      if (signal !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signalReasonAsError(signal!));
    };
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function signalReasonAsError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(
    typeof reason === 'string' && reason.length > 0 ? reason : 'aborted'
  );
}

const NOOP_LOGGER: Logger = Object.freeze({
  debug: () => {
    // noop
  },
  info: () => {
    // noop
  },
  warn: () => {
    // noop
  },
  error: () => {
    // noop
  },
});
