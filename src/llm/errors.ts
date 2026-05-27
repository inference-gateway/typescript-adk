/**
 * Base class for all errors thrown by {@link OpenAICompatibleLLMClient}.
 * Catch this to handle any LLM-client failure uniformly.
 */
export class LLMClientError extends Error {
  override readonly name: string = 'LLMClientError';

  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
  }
}

/**
 * Thrown when constructor arguments are invalid - missing `provider`, missing
 * `model`, etc. Surfaces configuration issues at construction time rather
 * than on the first request.
 */
export class LLMConfigurationError extends LLMClientError {
  override readonly name = 'LLMConfigurationError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when an upstream LLM request fails (HTTP error from the gateway,
 * mid-stream provider error, exhausted retries, etc.). The originating
 * error is forwarded via `Error.cause` when available.
 */
export class LLMRequestError extends LLMClientError {
  override readonly name = 'LLMRequestError';

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}
