import { describe, expect, it } from 'vitest';
import {
  A2AAbortError,
  A2AHTTPError,
  A2AJSONRPCError,
  A2ANetworkError,
  A2ATimeoutError,
} from '../../src/client/errors.js';
import { isRetryableError, withRetry } from '../../src/client/retry.js';

describe('isRetryableError', () => {
  it('does not retry abort errors', () => {
    expect(isRetryableError(new A2AAbortError())).toBe(false);
  });

  it('does not retry JSON-RPC error responses', () => {
    expect(
      isRetryableError(new A2AJSONRPCError(-32602, 'invalid params'))
    ).toBe(false);
  });

  it('retries on 5xx HTTP errors', () => {
    expect(isRetryableError(new A2AHTTPError(500, ''))).toBe(true);
    expect(isRetryableError(new A2AHTTPError(503, ''))).toBe(true);
    expect(isRetryableError(new A2AHTTPError(599, ''))).toBe(true);
  });

  it('retries on HTTP 429 (rate limit)', () => {
    expect(isRetryableError(new A2AHTTPError(429, ''))).toBe(true);
  });

  it('does not retry on other 4xx HTTP errors', () => {
    expect(isRetryableError(new A2AHTTPError(400, ''))).toBe(false);
    expect(isRetryableError(new A2AHTTPError(404, ''))).toBe(false);
    expect(isRetryableError(new A2AHTTPError(418, ''))).toBe(false);
  });

  it('retries on timeout errors', () => {
    expect(isRetryableError(new A2ATimeoutError(1000))).toBe(true);
  });

  it('retries on network errors', () => {
    expect(isRetryableError(new A2ANetworkError('ECONNRESET'))).toBe(true);
  });

  it('does not retry unknown errors', () => {
    expect(isRetryableError(new Error('mystery'))).toBe(false);
    expect(isRetryableError('not even an error')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});

describe('withRetry', () => {
  const fastConfig = {
    maxRetries: 3,
    initialDelayMs: 1,
    maxDelayMs: 10,
  };

  it('returns the result on first success without delay', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return 'ok';
      },
      fastConfig,
      () => true,
      undefined
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries on retryable failures and eventually succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new A2ANetworkError('boom');
        return 'finally';
      },
      fastConfig,
      isRetryableError,
      undefined
    );
    expect(result).toBe('finally');
    expect(calls).toBe(3);
  });

  it('throws after exhausting max retries', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new A2ANetworkError('persistent');
        },
        fastConfig,
        isRetryableError,
        undefined
      )
    ).rejects.toThrow(A2ANetworkError);
    expect(calls).toBe(fastConfig.maxRetries + 1);
  });

  it('propagates non-retryable errors immediately without retrying', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new A2AJSONRPCError(-32602, 'no');
        },
        fastConfig,
        isRetryableError,
        undefined
      )
    ).rejects.toThrow(A2AJSONRPCError);
    expect(calls).toBe(1);
  });

  it('aborts cleanly when the signal fires between attempts', async () => {
    let calls = 0;
    const controller = new AbortController();
    const promise = withRetry(
      async () => {
        calls++;
        controller.abort();
        throw new A2ANetworkError('boom');
      },
      { maxRetries: 3, initialDelayMs: 100, maxDelayMs: 100 },
      isRetryableError,
      controller.signal
    );
    await expect(promise).rejects.toThrow(A2AAbortError);
    expect(calls).toBe(1);
  });

  it('throws immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          return 'never';
        },
        fastConfig,
        isRetryableError,
        controller.signal
      )
    ).rejects.toThrow(A2AAbortError);
    expect(calls).toBe(0);
  });

  it('honors maxRetries: 0 to disable retries', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new A2ANetworkError('once');
        },
        { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 },
        isRetryableError,
        undefined
      )
    ).rejects.toThrow(A2ANetworkError);
    expect(calls).toBe(1);
  });
});
