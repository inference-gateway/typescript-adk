import {
  InferenceGatewayClient,
  type ChatCompletionStreamCallbacks,
  type SchemaCreateChatCompletionRequest,
} from '@inference-gateway/sdk';
import { createTLSFetch, type ClientTLSConfig } from '../tls/index.js';
import { LLMConfigurationError, LLMRequestError } from './errors.js';
import {
  Provider,
  type LLMMessage,
  type LLMRawUsage,
  type LLMResponse,
  type LLMStreamChunk,
  type LLMTool,
  type LLMUsage,
} from './types.js';

/**
 * Default per-attempt timeout for LLM requests, in milliseconds. Matches the
 * SDK's default and mirrors `defaultTimeoutMs` in the Go ADK.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/**
 * Default retry budget for transient transport errors. The retry policy is
 * intentionally linear-and-small - LLM calls are expensive and slow, so
 * retrying aggressively just wastes credits.
 */
export const DEFAULT_LLM_MAX_RETRIES = 2;

/**
 * Subset of {@link InferenceGatewayClient} that {@link OpenAICompatibleLLMClient}
 * depends on. Exposing this as an interface lets tests inject a fake without
 * pulling in the real HTTP client. Mirrors `LLMClient` in the Go ADK's
 * `server/agent_llm_client.go`.
 */
export interface LLMTransport {
  createChatCompletion(
    request: Omit<SchemaCreateChatCompletionRequest, 'stream'>,
    provider?: Provider
  ): Promise<LLMResponse>;
  streamChatCompletion(
    request: Omit<
      SchemaCreateChatCompletionRequest,
      'stream' | 'stream_options'
    >,
    callbacks: ChatCompletionStreamCallbacks,
    provider?: Provider,
    abortSignal?: AbortSignal
  ): Promise<void>;
}

/**
 * Construction options for {@link OpenAICompatibleLLMClient}. Mirrors the Go
 * ADK's `AgentConfig` LLM section: same provider/model/baseURL/apiKey/timeout
 * shape, plus a `client` slot for dependency injection in tests.
 */
export interface OpenAICompatibleLLMClientConfig {
  /**
   * Inference Gateway provider, e.g. `'openai'`, `'ollama'`, `'groq'`. Either
   * a {@link Provider} enum value or the raw string. Required.
   */
  readonly provider: Provider | string;
  /**
   * Model identifier, e.g. `'gpt-4o'`, `'llama-3.3-70b-versatile'`. Optional
   * `<provider>/<model>` prefix is stripped to match the Go ADK behavior.
   * Required.
   */
  readonly model: string;
  /**
   * Base URL of the Inference Gateway, including the `/v1` suffix.
   * Defaults to `http://localhost:8080/v1` (the SDK default).
   */
  readonly baseURL?: string;
  /** API key forwarded as `Authorization: Bearer <key>` to the gateway. */
  readonly apiKey?: string;
  /**
   * Per-attempt timeout in milliseconds. Defaults to
   * {@link DEFAULT_LLM_TIMEOUT_MS}.
   */
  readonly timeoutMs?: number;
  /** Static headers added to every outbound request. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Upper bound on tokens emitted by the model per request. Forwarded as
   * `max_tokens` on every chat completion. Unset = let the model/provider
   * decide.
   */
  readonly maxTokens?: number;
  /**
   * Number of retries on transient transport failures. Defaults to
   * {@link DEFAULT_LLM_MAX_RETRIES}. `0` disables retries entirely.
   */
  readonly maxRetries?: number;
  /** Custom `fetch` implementation. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Optional client TLS configuration for HTTPS calls to the gateway / LLM
   * provider. When set, the client builds a `fetch` backed by an
   * `https.Agent` configured with the supplied cert/key/CA - this is
   * mutually exclusive with the {@link fetch} slot. Supplying both throws
   * {@link LLMConfigurationError}.
   *
   * For local development against self-signed certs, set
   * `tls: { insecureSkipVerify: true }`. In production, point
   * {@link ClientTLSConfig.caPath} at the CA bundle that signed the peer.
   */
  readonly tls?: ClientTLSConfig;
  /**
   * Pre-built {@link LLMTransport} (typically a fake) used in tests. When
   * supplied, `baseURL`/`apiKey`/`headers`/`fetch`/`tls` on this config are
   * ignored - the caller is responsible for the transport's configuration.
   */
  readonly client?: LLMTransport;
}

/**
 * Per-call options accepted by {@link OpenAICompatibleLLMClient.chatCompletion}
 * and {@link OpenAICompatibleLLMClient.chatCompletionStream}.
 */
export interface ChatCompletionOptions {
  /**
   * Tools advertised to the model for this call. Each tool's `function.name`
   * must be unique. The model decides whether to invoke any of them.
   */
  readonly tools?: readonly LLMTool[];
  /**
   * Override the client's default `max_tokens` for this call.
   */
  readonly maxTokens?: number;
  /**
   * `raw` keeps `<think>` tags inline in the content (Ollama/DeepSeek default);
   * `parsed` routes reasoning to the dedicated `reasoning_content` / `reasoning`
   * fields. Forwarded as `reasoning_format`.
   */
  readonly reasoningFormat?: 'raw' | 'parsed';
  /**
   * Cancel an in-flight streaming request. Only honored by
   * {@link OpenAICompatibleLLMClient.chatCompletionStream} - the SDK does not
   * expose a signal for non-streaming requests.
   */
  readonly signal?: AbortSignal;
}

function stripProviderPrefix(model: string): string {
  const slash = model.indexOf('/');
  if (slash < 0) return model;
  return model.slice(slash + 1);
}

function normalizeProvider(value: Provider | string): Provider {
  const v =
    typeof value === 'string' ? (value.toLowerCase() as Provider) : value;
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

/**
 * OpenAI-compatible LLM client backed by the Inference Gateway SDK. Talks to
 * any provider routed through the gateway - OpenAI, Ollama, Groq, Cohere,
 * DeepSeek, etc. Mirrors `OpenAICompatibleLLMClient` in the Go ADK's
 * `server/agent_llm_client.go`.
 *
 * Provider note: Ollama's OpenAI-compatible endpoint sits at `/v1`. Pass
 * `baseURL: 'http://localhost:11434/v1'` to talk to Ollama directly without
 * the gateway in between.
 */
export class OpenAICompatibleLLMClient {
  private readonly transport: LLMTransport;
  private readonly provider: Provider;
  private readonly model: string;
  private readonly maxTokens: number | undefined;
  private readonly maxRetries: number;

  constructor(config: OpenAICompatibleLLMClientConfig) {
    if (
      typeof config.provider !== 'string' ||
      String(config.provider).length === 0
    ) {
      throw new LLMConfigurationError('provider is required');
    }
    if (typeof config.model !== 'string' || config.model.length === 0) {
      throw new LLMConfigurationError('model is required');
    }

    this.provider = normalizeProvider(config.provider);
    this.model = stripProviderPrefix(config.model);

    if (config.client !== undefined) {
      this.transport = config.client;
    } else {
      if (config.fetch !== undefined && config.tls !== undefined) {
        throw new LLMConfigurationError(
          'fetch and tls are mutually exclusive - build your own fetch from createTLSFetch if you need both'
        );
      }
      const options: ConstructorParameters<typeof InferenceGatewayClient>[0] = {
        timeout: config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
      };
      if (config.baseURL !== undefined) options.baseURL = config.baseURL;
      if (config.apiKey !== undefined) options.apiKey = config.apiKey;
      if (config.headers !== undefined)
        options.defaultHeaders = { ...config.headers };
      if (config.fetch !== undefined) {
        options.fetch = config.fetch;
      } else if (config.tls !== undefined) {
        options.fetch = createTLSFetch(
          config.tls
        ) as unknown as typeof globalThis.fetch;
      }
      this.transport = new InferenceGatewayClient(options);
    }

    if (config.maxTokens !== undefined) {
      this.maxTokens = config.maxTokens;
    }
    this.maxRetries = config.maxRetries ?? DEFAULT_LLM_MAX_RETRIES;
  }

  /** The provider this client routes through. */
  getProvider(): Provider {
    return this.provider;
  }

  /** The model identifier, with any `<provider>/` prefix stripped. */
  getModel(): string {
    return this.model;
  }

  /**
   * Issue a non-streaming chat completion. Retries on transport failures up
   * to `maxRetries` times with a 1s-per-attempt linear backoff (mirroring
   * the Go ADK).
   *
   * Throws {@link LLMRequestError} if the request fails after all retries or
   * returns no choices.
   */
  async chatCompletion(
    messages: readonly LLMMessage[],
    opts: ChatCompletionOptions = {}
  ): Promise<LLMResponse> {
    const request = this.buildRequest(messages, opts);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(attempt * 1000);
      }
      try {
        const response = await this.transport.createChatCompletion(
          request,
          this.provider
        );
        if (response.choices.length === 0) {
          throw new LLMRequestError('no choices returned from llm');
        }
        return response;
      } catch (err) {
        if (
          err instanceof LLMRequestError &&
          err.message.includes('no choices')
        ) {
          throw err;
        }
        lastErr = err;
      }
    }

    throw new LLMRequestError(
      `llm request failed after ${this.maxRetries} retries`,
      lastErr
    );
  }

  /**
   * Issue a streaming chat completion. Returns an async iterable that yields
   * one {@link LLMStreamChunk} per SSE `content-delta` event. The iterable
   * completes normally when the stream ends and throws an
   * {@link LLMRequestError} on transport / mid-stream provider failure.
   *
   * Pass `opts.signal` to cancel an in-flight stream. Aborting partway
   * through stops further yields and propagates an `AbortError`.
   *
   * Unlike {@link chatCompletion}, streaming requests are not retried - a
   * partial response cannot be safely resumed from the client side.
   */
  chatCompletionStream(
    messages: readonly LLMMessage[],
    opts: ChatCompletionOptions = {}
  ): AsyncIterable<LLMStreamChunk> {
    const request = this.buildRequest(messages, opts);
    const provider = this.provider;
    const transport = this.transport;
    const signal = opts.signal;

    return createStreamIterator((callbacks) =>
      transport.streamChatCompletion(request, callbacks, provider, signal)
    );
  }

  /**
   * Convert an LLM response's `usage` field to camelCase form. Returns
   * `undefined` if the response carries no usage info (some providers omit it
   * for short completions or when streaming without `include_usage`).
   */
  static extractUsage(
    response: LLMResponse | LLMStreamChunk
  ): LLMUsage | undefined {
    const usage: LLMRawUsage | undefined = response.usage;
    if (usage === undefined) return undefined;
    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    };
  }

  private buildRequest(
    messages: readonly LLMMessage[],
    opts: ChatCompletionOptions
  ): Omit<SchemaCreateChatCompletionRequest, 'stream' | 'stream_options'> {
    const request: Omit<
      SchemaCreateChatCompletionRequest,
      'stream' | 'stream_options'
    > = {
      model: this.model,
      messages: messages as LLMMessage[],
    };
    const maxTokens = opts.maxTokens ?? this.maxTokens;
    if (maxTokens !== undefined) {
      (request as { max_tokens?: number }).max_tokens = maxTokens;
    }
    if (opts.tools !== undefined && opts.tools.length > 0) {
      (request as { tools?: readonly LLMTool[] }).tools = opts.tools;
    }
    if (opts.reasoningFormat !== undefined) {
      (request as { reasoning_format?: string }).reasoning_format =
        opts.reasoningFormat;
    }
    return request;
  }
}

/**
 * Convenience factory equivalent to `new OpenAICompatibleLLMClient(config)`.
 */
export function createOpenAICompatibleLLMClient(
  config: OpenAICompatibleLLMClientConfig
): OpenAICompatibleLLMClient {
  return new OpenAICompatibleLLMClient(config);
}

/**
 * Bridge the SDK's callback-driven `streamChatCompletion` into an async
 * iterable. Buffers chunks until the consumer pulls them; surfaces errors
 * (both pre-flight rejections from the SDK and `onError` callbacks) as
 * thrown {@link LLMRequestError}s on the next `next()` call.
 */
function createStreamIterator(
  start: (callbacks: ChatCompletionStreamCallbacks) => Promise<void>
): AsyncIterable<LLMStreamChunk> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<LLMStreamChunk> {
      const buffer: LLMStreamChunk[] = [];
      let finished = false;
      let error: Error | null = null;
      let waker: (() => void) | null = null;

      const wake = (): void => {
        if (waker !== null) {
          const w = waker;
          waker = null;
          w();
        }
      };

      const finish = (err: unknown): void => {
        if (err !== undefined) {
          error = err instanceof Error ? err : new LLMRequestError(String(err));
        }
        finished = true;
        wake();
      };

      const startPromise = start({
        onChunk: (chunk) => {
          buffer.push(chunk);
          wake();
        },
        onFinish: () => {
          finished = true;
          wake();
        },
        onError: (err) => {
          finish(new LLMRequestError(err.error ?? 'unknown llm stream error'));
        },
      }).catch((err: unknown) => {
        finish(err);
      });

      return {
        async next(): Promise<IteratorResult<LLMStreamChunk>> {
          while (true) {
            if (buffer.length > 0) {
              const value = buffer.shift() as LLMStreamChunk;
              return { value, done: false };
            }
            if (finished) {
              await startPromise;
              if (error !== null) throw error;
              return { value: undefined, done: true };
            }
            await new Promise<void>((resolve) => {
              waker = resolve;
            });
          }
        },
        async return(): Promise<IteratorResult<LLMStreamChunk>> {
          finished = true;
          wake();
          await startPromise;
          return { value: undefined, done: true };
        },
      };
    },
  };
}
