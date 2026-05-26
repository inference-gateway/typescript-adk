import {
  A2AAbortError,
  A2AHTTPError,
  A2AJSONRPCError,
  A2ANetworkError,
  A2ATimeoutError,
} from './errors.js';

export interface RetryConfig {
  /** Maximum retry attempts after the initial try. `0` disables retries. */
  readonly maxRetries: number;
  /** Base delay before the first retry, in milliseconds. */
  readonly initialDelayMs: number;
  /** Upper bound on the per-attempt delay, in milliseconds. */
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = Object.freeze({
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
});

/**
 * Default policy for retryability:
 *  - Abort errors → never retry (user cancelled).
 *  - JSON-RPC error responses → never retry (deterministic application error).
 *  - HTTP errors → retry only on 5xx and 429.
 *  - Network errors and timeouts → retry.
 *  - Anything else → don't retry.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof A2AAbortError) return false;
  if (err instanceof A2AJSONRPCError) return false;
  if (err instanceof A2AHTTPError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  if (err instanceof A2ATimeoutError) return true;
  if (err instanceof A2ANetworkError) return true;
  return false;
}

/**
 * Execute `operation` with exponential-backoff retry semantics. `shouldRetry`
 * decides whether a failure is retryable; non-retryable errors propagate
 * immediately. The supplied `AbortSignal` aborts pending inter-attempt sleeps.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig,
  shouldRetry: (err: unknown) => boolean,
  signal: AbortSignal | undefined
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (signal?.aborted === true) {
      throw new A2AAbortError();
    }
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (attempt === config.maxRetries || !shouldRetry(err)) {
        throw err;
      }
      const delay = Math.min(
        config.initialDelayMs * 2 ** attempt,
        config.maxDelayMs
      );
      await sleepRespectingSignal(delay, signal);
    }
  }
  throw lastErr;
}

function sleepRespectingSignal(
  ms: number,
  signal: AbortSignal | undefined
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new A2AAbortError());
      return;
    }
    const timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new A2AAbortError());
    };
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
