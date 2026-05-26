/**
 * Base class for all errors thrown by {@link A2AClient}. Catch this to handle
 * any client-side failure uniformly.
 */
export class A2AClientError extends Error {
  override readonly name: string = 'A2AClientError';

  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
  }
}

/**
 * Thrown when the remote agent returns a non-2xx HTTP status. Carries the
 * raw response body (best-effort) so callers can surface it for debugging.
 */
export class A2AHTTPError extends A2AClientError {
  override readonly name = 'A2AHTTPError';
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, responseBody: string, message?: string) {
    super(message ?? `unexpected HTTP status ${status}`);
    this.status = status;
    this.responseBody = responseBody;
  }
}

/**
 * Thrown when the remote agent returns a JSON-RPC error response. The
 * `code`/`message`/`data` fields are forwarded verbatim from the wire.
 */
export class A2AJSONRPCError extends A2AClientError {
  override readonly name = 'A2AJSONRPCError';
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * Thrown when a request exceeds the configured `timeoutMs`. Retry logic
 * treats this as retryable.
 */
export class A2ATimeoutError extends A2AClientError {
  override readonly name = 'A2ATimeoutError';
  readonly timeoutMs: number;

  constructor(timeoutMs: number, cause?: unknown) {
    super(`request timed out after ${timeoutMs}ms`, cause);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when a request is cancelled via the caller's `AbortSignal`. Retry
 * logic treats this as non-retryable - user-initiated cancellations should
 * propagate immediately.
 */
export class A2AAbortError extends A2AClientError {
  override readonly name = 'A2AAbortError';

  constructor(cause?: unknown) {
    super('request aborted', cause);
  }
}

/**
 * Thrown when the underlying `fetch` rejects with a transport-level failure
 * (DNS, TCP reset, TLS handshake, etc.). Retryable by default.
 */
export class A2ANetworkError extends A2AClientError {
  override readonly name = 'A2ANetworkError';

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}
