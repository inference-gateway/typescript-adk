import { describe, expect, it } from 'vitest';
import {
  A2AAbortError,
  A2AClient,
  A2AClientError,
  A2AHTTPError,
  A2AJSONRPCError,
  A2ANetworkError,
  A2ATimeoutError,
  createA2AClient,
  type FetchLike,
} from '../../src/client/index.js';
import type { AgentCard, Message, Task } from '../../src/types/index.js';

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

interface MockFetchOptions {
  readonly status?: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
  readonly delayMs?: number;
}

function mockFetch(options: MockFetchOptions | MockFetchOptions[]): {
  fetch: FetchLike;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const responses = Array.isArray(options) ? options : [options];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    const spec = responses[Math.min(i, responses.length - 1)]!;
    i++;
    const signal = init.signal;
    // Mirror the real fetch contract: throw immediately if the signal is
    // already aborted, and throw if it fires during an in-flight delay.
    if (signal?.aborted === true) {
      throw signalReasonAsError(signal);
    }
    if (spec.delayMs !== undefined && spec.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, spec.delayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(signalReasonAsError(signal));
          },
          { once: true }
        );
      });
    }
    const status = spec.status ?? 200;
    const bodyText =
      typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
    return new Response(bodyText, {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...(spec.headers ?? {}),
      },
    });
  };
  return { fetch: fetchImpl, calls };
}

function throwingFetch(
  error: unknown,
  callsRef?: { count: number }
): FetchLike {
  return async () => {
    if (callsRef !== undefined) callsRef.count++;
    throw error;
  };
}

function signalReasonAsError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

function sampleAgentCard(): AgentCard {
  return {
    name: 'mock-agent',
    description: 'agent for unit tests',
    version: '0.0.1',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: { streaming: false },
    skills: [],
  };
}

function sampleMessage(): Message {
  return {
    messageId: 'm-1',
    role: 'ROLE_USER',
    parts: [{ text: 'hello' }],
    contextId: 'ctx-1',
  };
}

function sampleTask(): Task {
  return {
    id: 'task-1',
    contextId: 'ctx-1',
    status: { state: 'TASK_STATE_SUBMITTED' },
    history: [sampleMessage()],
  };
}

describe('A2AClient construction', () => {
  it('requires baseURL', () => {
    expect(() => new A2AClient({ baseURL: '' })).toThrow(A2AClientError);
  });

  it('strips trailing slash from baseURL', () => {
    const { fetch } = mockFetch({ body: sampleAgentCard() });
    const client = new A2AClient({ baseURL: 'http://x/', fetch });
    expect(client.getBaseURL()).toBe('http://x');
  });

  it('exposes createA2AClient factory equivalent to new A2AClient', () => {
    const { fetch } = mockFetch({ body: sampleAgentCard() });
    const client = createA2AClient({ baseURL: 'http://x', fetch });
    expect(client).toBeInstanceOf(A2AClient);
  });

  it('throws when no fetch is available and globalThis.fetch is undefined', () => {
    const original = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      expect(() => new A2AClient({ baseURL: 'http://x' })).toThrow(
        A2AClientError
      );
    } finally {
      (globalThis as { fetch: typeof original }).fetch = original;
    }
  });
});

describe('A2AClient.getAgentCard', () => {
  it('GETs the discovery path and returns the parsed card', async () => {
    const card = sampleAgentCard();
    const { fetch, calls } = mockFetch({ body: card });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: false,
    });

    const result = await client.getAgentCard();

    expect(result).toEqual(card);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://agent.test/.well-known/agent-card.json');
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('uses a custom agentCardPath when configured', async () => {
    const { fetch, calls } = mockFetch({ body: sampleAgentCard() });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      agentCardPath: '/custom/card.json',
      fetch,
      retry: false,
    });
    await client.getAgentCard();
    expect(calls[0]?.url).toBe('http://agent.test/custom/card.json');
  });

  it('throws A2AHTTPError on non-2xx responses', async () => {
    const { fetch } = mockFetch({ status: 500, body: 'oops' });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: false,
    });
    await expect(client.getAgentCard()).rejects.toThrow(A2AHTTPError);
  });

  it('attaches the configured User-Agent header', async () => {
    const { fetch, calls } = mockFetch({ body: sampleAgentCard() });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      userAgent: 'test-ua/9.9',
      fetch,
      retry: false,
    });
    await client.getAgentCard();
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('user-agent')).toBe('test-ua/9.9');
  });

  it('attaches static custom headers', async () => {
    const { fetch, calls } = mockFetch({ body: sampleAgentCard() });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      headers: { Authorization: 'Bearer abc' },
      fetch,
      retry: false,
    });
    await client.getAgentCard();
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer abc');
  });
});

describe('A2AClient.getHealth', () => {
  it('GETs /health and returns the status object', async () => {
    const { fetch, calls } = mockFetch({ body: { status: 'healthy' } });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: false,
    });

    const result = await client.getHealth();

    expect(result).toEqual({ status: 'healthy' });
    expect(calls[0]?.url).toBe('http://agent.test/health');
  });

  it('rejects when the response is missing a status field', async () => {
    const { fetch } = mockFetch({ body: { not: 'health' } });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: false,
    });
    await expect(client.getHealth()).rejects.toThrow(A2AClientError);
  });
});

describe('A2AClient.sendMessage', () => {
  it('POSTs a JSON-RPC envelope to the configured path and returns result', async () => {
    const task = sampleTask();
    const { fetch, calls } = mockFetch({
      body: { jsonrpc: '2.0', id: 1, result: task },
    });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: false,
    });

    const result = await client.sendMessage({ message: sampleMessage() });

    expect(result).toEqual(task);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://agent.test/');
    expect(calls[0]?.init.method).toBe('POST');

    const body = JSON.parse(calls[0]?.init.body as string) as {
      jsonrpc: string;
      method: string;
      params: { message: Message };
      id: number;
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('message/send');
    expect(body.id).toBe(1);
    expect(body.params.message.messageId).toBe('m-1');

    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('uses a custom jsonRpcPath when configured', async () => {
    const { fetch, calls } = mockFetch({
      body: { jsonrpc: '2.0', id: 1, result: sampleTask() },
    });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      jsonRpcPath: '/a2a',
      fetch,
      retry: false,
    });
    await client.sendMessage({ message: sampleMessage() });
    expect(calls[0]?.url).toBe('http://agent.test/a2a');
  });

  it('increments the JSON-RPC id between calls', async () => {
    const { fetch, calls } = mockFetch([
      { body: { jsonrpc: '2.0', id: 1, result: sampleTask() } },
      { body: { jsonrpc: '2.0', id: 2, result: sampleTask() } },
    ]);
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: false,
    });
    await client.sendMessage({ message: sampleMessage() });
    await client.sendMessage({ message: sampleMessage() });
    const b1 = JSON.parse(calls[0]?.init.body as string) as { id: number };
    const b2 = JSON.parse(calls[1]?.init.body as string) as { id: number };
    expect(b1.id).toBe(1);
    expect(b2.id).toBe(2);
  });

  it('throws A2AJSONRPCError when the server returns a JSON-RPC error', async () => {
    const { fetch } = mockFetch({
      body: {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32602, message: 'invalid params' },
      },
    });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: false,
    });
    try {
      await client.sendMessage({ message: sampleMessage() });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(A2AJSONRPCError);
      expect((err as A2AJSONRPCError).code).toBe(-32602);
      expect((err as A2AJSONRPCError).message).toBe('invalid params');
    }
  });

  it('forwards the error data field on JSON-RPC errors', async () => {
    const { fetch } = mockFetch({
      body: {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32000,
          message: 'app error',
          data: { hint: 'check input' },
        },
      },
    });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: false,
    });
    try {
      await client.sendMessage({ message: sampleMessage() });
    } catch (err) {
      expect((err as A2AJSONRPCError).data).toEqual({ hint: 'check input' });
    }
  });

  it('throws A2AClientError when neither result nor error is present', async () => {
    const { fetch } = mockFetch({ body: { jsonrpc: '2.0', id: 1 } });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: false,
    });
    await expect(
      client.sendMessage({ message: sampleMessage() })
    ).rejects.toThrow(A2AClientError);
  });
});

describe('A2AClient.getTask', () => {
  it('POSTs tasks/get with the taskId and returns the task', async () => {
    const task = sampleTask();
    const { fetch, calls } = mockFetch({
      body: { jsonrpc: '2.0', id: 1, result: task },
    });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: false,
    });

    const result = await client.getTask('task-1');
    expect(result).toEqual(task);
    const body = JSON.parse(calls[0]?.init.body as string) as {
      method: string;
      params: { taskId: string };
    };
    expect(body.method).toBe('tasks/get');
    expect(body.params).toEqual({ taskId: 'task-1' });
  });

  it('passes historyLength and metadata through when supplied', async () => {
    const { fetch, calls } = mockFetch({
      body: { jsonrpc: '2.0', id: 1, result: sampleTask() },
    });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: false,
    });
    await client.getTask('task-1', {
      historyLength: 5,
      metadata: { trace: 'abc' },
    });
    const body = JSON.parse(calls[0]?.init.body as string) as {
      params: { taskId: string; historyLength: number; metadata: unknown };
    };
    expect(body.params).toEqual({
      taskId: 'task-1',
      historyLength: 5,
      metadata: { trace: 'abc' },
    });
  });

  it('omits historyLength from params when not supplied', async () => {
    const { fetch, calls } = mockFetch({
      body: { jsonrpc: '2.0', id: 1, result: sampleTask() },
    });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: false,
    });
    await client.getTask('task-1');
    const body = JSON.parse(calls[0]?.init.body as string) as {
      params: Record<string, unknown>;
    };
    expect('historyLength' in body.params).toBe(false);
    expect('metadata' in body.params).toBe(false);
  });
});

describe('A2AClient retries', () => {
  it('retries 5xx responses up to maxRetries then succeeds', async () => {
    const { fetch, calls } = mockFetch([
      { status: 503, body: { msg: 'busy' } },
      { status: 503, body: { msg: 'busy' } },
      { body: sampleAgentCard() },
    ]);
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: { initialDelayMs: 1, maxDelayMs: 1 },
    });
    const card = await client.getAgentCard();
    expect(card).toEqual(sampleAgentCard());
    expect(calls).toHaveLength(3);
  });

  it('does not retry 4xx responses', async () => {
    const { fetch, calls } = mockFetch({ status: 404, body: { msg: 'nope' } });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: { initialDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(client.getAgentCard()).rejects.toThrow(A2AHTTPError);
    expect(calls).toHaveLength(1);
  });

  it('retries network errors then propagates after exhausting attempts', async () => {
    const callsRef = { count: 0 };
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch: throwingFetch(new Error('ECONNRESET'), callsRef),
      retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(client.getAgentCard()).rejects.toThrow(A2ANetworkError);
    expect(callsRef.count).toBe(3);
  });

  it('disables retries when retry: false', async () => {
    const callsRef = { count: 0 };
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch: throwingFetch(new Error('ECONNRESET'), callsRef),
      retry: false,
    });
    await expect(client.getAgentCard()).rejects.toThrow(A2ANetworkError);
    expect(callsRef.count).toBe(1);
  });

  it('does not retry JSON-RPC error responses', async () => {
    const { fetch, calls } = mockFetch({
      body: {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32602, message: 'bad' },
      },
    });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: { initialDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(
      client.sendMessage({ message: sampleMessage() })
    ).rejects.toThrow(A2AJSONRPCError);
    expect(calls).toHaveLength(1);
  });
});

describe('A2AClient timeouts and aborts', () => {
  it('throws A2ATimeoutError when fetch exceeds timeoutMs', async () => {
    const { fetch } = mockFetch({ body: sampleAgentCard(), delayMs: 200 });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      timeoutMs: 20,
      retry: false,
    });
    await expect(client.getAgentCard()).rejects.toThrow(A2ATimeoutError);
  });

  it('throws A2AAbortError when caller aborts via signal', async () => {
    const { fetch } = mockFetch({ body: sampleAgentCard(), delayMs: 200 });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: false,
    });
    const controller = new AbortController();
    const promise = client.getAgentCard({ signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(promise).rejects.toThrow(A2AAbortError);
  });

  it('rejects immediately when signal is already aborted', async () => {
    const { fetch } = mockFetch({ body: sampleAgentCard() });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      retry: false,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.getAgentCard({ signal: controller.signal })
    ).rejects.toThrow(A2AAbortError);
  });

  it('treats timeoutMs: 0 as no timeout', async () => {
    const { fetch } = mockFetch({ body: sampleAgentCard(), delayMs: 30 });
    const client = new A2AClient({
      baseURL: 'http://agent.test',
      fetch,
      timeoutMs: 0,
      retry: false,
    });
    const card = await client.getAgentCard();
    expect(card).toEqual(sampleAgentCard());
  });
});
