import { describe, expect, it } from 'vitest';
import {
  A2AAbortError,
  A2AClientError,
  A2AHTTPError,
  A2AJSONRPCError,
  A2ANetworkError,
  A2ATimeoutError,
} from '../../src/client/errors.js';

describe('A2A client error hierarchy', () => {
  it('all client errors extend A2AClientError', () => {
    expect(new A2AHTTPError(500, '')).toBeInstanceOf(A2AClientError);
    expect(new A2AJSONRPCError(-1, 'x')).toBeInstanceOf(A2AClientError);
    expect(new A2ATimeoutError(1000)).toBeInstanceOf(A2AClientError);
    expect(new A2AAbortError()).toBeInstanceOf(A2AClientError);
    expect(new A2ANetworkError('boom')).toBeInstanceOf(A2AClientError);
  });

  it('preserves cause via standard Error.cause', () => {
    const root = new Error('original');
    const err = new A2AClientError('wrapper', root);
    expect(err.cause).toBe(root);
  });

  it('A2AHTTPError carries status and responseBody', () => {
    const err = new A2AHTTPError(503, 'service unavailable');
    expect(err.status).toBe(503);
    expect(err.responseBody).toBe('service unavailable');
    expect(err.name).toBe('A2AHTTPError');
  });

  it('A2AJSONRPCError carries code, message, and data', () => {
    const err = new A2AJSONRPCError(-32602, 'invalid', { field: 'taskId' });
    expect(err.code).toBe(-32602);
    expect(err.message).toBe('invalid');
    expect(err.data).toEqual({ field: 'taskId' });
    expect(err.name).toBe('A2AJSONRPCError');
  });

  it('A2ATimeoutError carries timeoutMs and a descriptive message', () => {
    const err = new A2ATimeoutError(5000);
    expect(err.timeoutMs).toBe(5000);
    expect(err.message).toContain('5000');
    expect(err.name).toBe('A2ATimeoutError');
  });

  it('A2AAbortError uses a stable name', () => {
    const err = new A2AAbortError();
    expect(err.name).toBe('A2AAbortError');
    expect(err.message).toBe('request aborted');
  });

  it('A2ANetworkError uses a stable name and propagates message', () => {
    const err = new A2ANetworkError('ECONNRESET');
    expect(err.name).toBe('A2ANetworkError');
    expect(err.message).toBe('ECONNRESET');
  });
});
