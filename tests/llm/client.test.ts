import { describe, expect, it, vi } from 'vitest';
import type {
  ChatCompletionStreamCallbacks,
  SchemaCreateChatCompletionRequest,
} from '@inference-gateway/sdk';
import {
  ChatCompletionToolType,
  FinishReason,
  LLMClientError,
  LLMConfigurationError,
  LLMRequestError,
  MessageRole,
  OpenAICompatibleLLMClient,
  Provider,
  createOpenAICompatibleLLMClient,
  type LLMMessage,
  type LLMResponse,
  type LLMStreamChunk,
  type LLMTool,
  type LLMTransport,
} from '../../src/llm/index.js';

interface FakeCompletionCall {
  readonly request: Omit<SchemaCreateChatCompletionRequest, 'stream'>;
  readonly provider: Provider | undefined;
}

interface FakeStreamCall {
  readonly request: Omit<
    SchemaCreateChatCompletionRequest,
    'stream' | 'stream_options'
  >;
  readonly provider: Provider | undefined;
  readonly signal: AbortSignal | undefined;
}

interface FakeTransport extends LLMTransport {
  readonly completionCalls: FakeCompletionCall[];
  readonly streamCalls: FakeStreamCall[];
}

function makeResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    id: 'cmpl-test',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        finish_reason: FinishReason.Stop,
        message: {
          role: MessageRole.Assistant,
          content: 'hello',
        },
      },
    ],
    usage: {
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
    },
    ...overrides,
  };
}

function makeStreamChunk(
  overrides: Partial<LLMStreamChunk> = {}
): LLMStreamChunk {
  return {
    id: 'cmpl-test',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        delta: { content: 'hi', role: MessageRole.Assistant },
        finish_reason: FinishReason.Stop,
      },
    ],
    ...overrides,
  };
}

function fakeTransport(
  options: {
    completionResponses?: readonly (LLMResponse | Error)[];
    streamScript?: (
      callbacks: ChatCompletionStreamCallbacks,
      signal: AbortSignal | undefined
    ) => Promise<void> | void;
    streamRejection?: Error;
  } = {}
): FakeTransport {
  const completionCalls: FakeCompletionCall[] = [];
  const streamCalls: FakeStreamCall[] = [];
  let completionIndex = 0;
  return {
    completionCalls,
    streamCalls,
    async createChatCompletion(request, provider) {
      completionCalls.push({ request, provider });
      const queue = options.completionResponses ?? [makeResponse()];
      const item = queue[Math.min(completionIndex, queue.length - 1)];
      completionIndex++;
      if (item instanceof Error) throw item;
      return item as LLMResponse;
    },
    async streamChatCompletion(request, callbacks, provider, signal) {
      streamCalls.push({ request, provider, signal });
      if (options.streamRejection) throw options.streamRejection;
      if (options.streamScript) {
        await options.streamScript(callbacks, signal);
      } else {
        callbacks.onChunk?.(makeStreamChunk());
        callbacks.onFinish?.(null);
      }
    },
  };
}

const userMessage: LLMMessage = {
  role: MessageRole.User,
  content: 'hello',
};

const weatherTool: LLMTool = {
  type: ChatCompletionToolType.function,
  function: {
    name: 'get_weather',
    description: 'Get the weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
    strict: true,
  },
};

describe('OpenAICompatibleLLMClient construction', () => {
  it('rejects an empty provider', () => {
    expect(
      () =>
        new OpenAICompatibleLLMClient({
          provider: '',
          model: 'gpt-4o',
          client: fakeTransport(),
        })
    ).toThrow(LLMConfigurationError);
  });

  it('rejects an empty model', () => {
    expect(
      () =>
        new OpenAICompatibleLLMClient({
          provider: Provider.openai,
          model: '',
          client: fakeTransport(),
        })
    ).toThrow(LLMConfigurationError);
  });

  it('strips a "<provider>/" prefix from the model identifier', () => {
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'openai/gpt-4o',
      client: fakeTransport(),
    });
    expect(client.getModel()).toBe('gpt-4o');
  });

  it('normalizes provider strings to lowercase', () => {
    const client = new OpenAICompatibleLLMClient({
      provider: 'OpenAI',
      model: 'gpt-4o',
      client: fakeTransport(),
    });
    expect(client.getProvider()).toBe(Provider.openai);
  });

  it('accepts Provider.llamacpp as a typed provider', () => {
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.llamacpp,
      model: 'qwen2.5',
      client: fakeTransport(),
    });
    expect(client.getProvider()).toBe(Provider.llamacpp);
  });

  it('exposes createOpenAICompatibleLLMClient as a factory', () => {
    const client = createOpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      client: fakeTransport(),
    });
    expect(client).toBeInstanceOf(OpenAICompatibleLLMClient);
  });
});

describe('OpenAICompatibleLLMClient.chatCompletion', () => {
  it('forwards model/messages/provider to the transport', async () => {
    const transport = fakeTransport();
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      client: transport,
    });

    const response = await client.chatCompletion([userMessage]);

    expect(transport.completionCalls).toHaveLength(1);
    expect(transport.completionCalls[0]?.provider).toBe(Provider.openai);
    expect(transport.completionCalls[0]?.request.model).toBe('gpt-4o');
    expect(transport.completionCalls[0]?.request.messages).toEqual([
      userMessage,
    ]);
    expect(response.id).toBe('cmpl-test');
  });

  it('forwards max_tokens from the client config when set', async () => {
    const transport = fakeTransport();
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      maxTokens: 256,
      client: transport,
    });

    await client.chatCompletion([userMessage]);

    expect(
      (transport.completionCalls[0]?.request as { max_tokens?: number })
        .max_tokens
    ).toBe(256);
  });

  it('per-call maxTokens overrides the constructor default', async () => {
    const transport = fakeTransport();
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      maxTokens: 256,
      client: transport,
    });

    await client.chatCompletion([userMessage], { maxTokens: 512 });

    expect(
      (transport.completionCalls[0]?.request as { max_tokens?: number })
        .max_tokens
    ).toBe(512);
  });

  it('forwards tools when provided', async () => {
    const transport = fakeTransport();
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      client: transport,
    });

    await client.chatCompletion([userMessage], { tools: [weatherTool] });

    const request = transport.completionCalls[0]?.request as {
      tools?: readonly LLMTool[];
    };
    expect(request.tools).toEqual([weatherTool]);
  });

  it('omits tools when none are provided', async () => {
    const transport = fakeTransport();
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      client: transport,
    });

    await client.chatCompletion([userMessage]);

    expect(
      (transport.completionCalls[0]?.request as { tools?: readonly LLMTool[] })
        .tools
    ).toBeUndefined();
  });

  it('forwards reasoning_format when provided', async () => {
    const transport = fakeTransport();
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      client: transport,
    });

    await client.chatCompletion([userMessage], { reasoningFormat: 'parsed' });

    expect(
      (transport.completionCalls[0]?.request as { reasoning_format?: string })
        .reasoning_format
    ).toBe('parsed');
  });

  it('retries transient transport errors before succeeding', async () => {
    const transport = fakeTransport({
      completionResponses: [
        new Error('network blip'),
        new Error('network blip 2'),
        makeResponse(),
      ],
    });
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      maxRetries: 2,
      client: transport,
    });

    const sleepSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((cb: () => void) => {
        cb();
        return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
      });
    try {
      const response = await client.chatCompletion([userMessage]);
      expect(response.id).toBe('cmpl-test');
      expect(transport.completionCalls).toHaveLength(3);
    } finally {
      sleepSpy.mockRestore();
    }
  });

  it('throws LLMRequestError after exhausting retries', async () => {
    const transport = fakeTransport({
      completionResponses: [
        new Error('boom'),
        new Error('boom'),
        new Error('boom'),
      ],
    });
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      maxRetries: 2,
      client: transport,
    });

    const sleepSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((cb: () => void) => {
        cb();
        return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
      });
    try {
      await expect(client.chatCompletion([userMessage])).rejects.toBeInstanceOf(
        LLMRequestError
      );
      expect(transport.completionCalls).toHaveLength(3);
    } finally {
      sleepSpy.mockRestore();
    }
  });

  it('does not retry on empty-choices responses', async () => {
    const transport = fakeTransport({
      completionResponses: [makeResponse({ choices: [] })],
    });
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      maxRetries: 2,
      client: transport,
    });

    await expect(client.chatCompletion([userMessage])).rejects.toBeInstanceOf(
      LLMRequestError
    );
    expect(transport.completionCalls).toHaveLength(1);
  });

  it('LLMRequestError is a subclass of LLMClientError', () => {
    const err = new LLMRequestError('x');
    expect(err).toBeInstanceOf(LLMClientError);
    expect(err.name).toBe('LLMRequestError');
  });
});

describe('OpenAICompatibleLLMClient.chatCompletionStream', () => {
  it('yields chunks emitted by the SDK callback', async () => {
    const transport = fakeTransport({
      streamScript: (callbacks) => {
        callbacks.onChunk?.(makeStreamChunk({ id: 'a' }));
        callbacks.onChunk?.(makeStreamChunk({ id: 'b' }));
        callbacks.onFinish?.(null);
      },
    });
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      client: transport,
    });

    const ids: string[] = [];
    for await (const chunk of client.chatCompletionStream([userMessage])) {
      ids.push(chunk.id);
    }
    expect(ids).toEqual(['a', 'b']);
  });

  it('throws LLMRequestError when the SDK emits onError', async () => {
    const transport = fakeTransport({
      streamScript: (callbacks) => {
        callbacks.onChunk?.(makeStreamChunk({ id: 'a' }));
        callbacks.onError?.({ error: 'provider exploded' });
      },
    });
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      client: transport,
    });

    const ids: string[] = [];
    let caught: unknown;
    try {
      for await (const chunk of client.chatCompletionStream([userMessage])) {
        ids.push(chunk.id);
      }
    } catch (err) {
      caught = err;
    }
    expect(ids).toEqual(['a']);
    expect(caught).toBeInstanceOf(LLMRequestError);
    expect((caught as Error).message).toContain('provider exploded');
  });

  it('throws LLMRequestError when the streamChatCompletion promise rejects', async () => {
    const transport = fakeTransport({
      streamRejection: new Error('failed to open stream'),
    });
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      client: transport,
    });

    let caught: unknown;
    try {
      for await (const _ of client.chatCompletionStream([userMessage])) {
        // unreachable
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('failed to open stream');
  });

  it('forwards the caller-provided AbortSignal to the SDK', async () => {
    const transport = fakeTransport();
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      client: transport,
    });
    const controller = new AbortController();

    const iter = client.chatCompletionStream([userMessage], {
      signal: controller.signal,
    });
    for await (const _ of iter) {
      // drain
    }
    expect(transport.streamCalls[0]?.signal).toBe(controller.signal);
  });

  it('passes tools through to the streaming request', async () => {
    const transport = fakeTransport();
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      client: transport,
    });

    for await (const _ of client.chatCompletionStream([userMessage], {
      tools: [weatherTool],
    })) {
      // drain
    }
    expect(
      (transport.streamCalls[0]?.request as { tools?: readonly LLMTool[] })
        .tools
    ).toEqual([weatherTool]);
  });

  it('cleans up when the consumer breaks out of the loop early', async () => {
    const transport = fakeTransport({
      streamScript: async (callbacks) => {
        callbacks.onChunk?.(makeStreamChunk({ id: '1' }));
        callbacks.onChunk?.(makeStreamChunk({ id: '2' }));
        callbacks.onFinish?.(null);
      },
    });
    const client = new OpenAICompatibleLLMClient({
      provider: Provider.openai,
      model: 'gpt-4o',
      client: transport,
    });

    const seen: string[] = [];
    for await (const chunk of client.chatCompletionStream([userMessage])) {
      seen.push(chunk.id);
      break;
    }
    expect(seen).toEqual(['1']);
  });
});

describe('OpenAICompatibleLLMClient.extractUsage', () => {
  it('normalizes snake_case usage to camelCase', () => {
    const usage = OpenAICompatibleLLMClient.extractUsage(makeResponse());
    expect(usage).toEqual({
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12,
    });
  });

  it('returns undefined when the response carries no usage info', () => {
    const response = makeResponse();
    delete (response as { usage?: unknown }).usage;
    expect(OpenAICompatibleLLMClient.extractUsage(response)).toBeUndefined();
  });

  it('works on streaming chunks too', () => {
    const chunk = makeStreamChunk({
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(OpenAICompatibleLLMClient.extractUsage(chunk)).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    });
  });
});
