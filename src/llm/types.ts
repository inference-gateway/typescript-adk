import type {
  SchemaChatCompletionMessageToolCall,
  SchemaChatCompletionTool,
  SchemaCompletionUsage,
  SchemaCreateChatCompletionResponse,
  SchemaCreateChatCompletionStreamResponse,
  SchemaMessage,
} from '@inference-gateway/sdk';

export {
  ChatCompletionToolType,
  FinishReason,
  MessageRole,
  Provider,
} from '@inference-gateway/sdk';

/**
 * A single chat message exchanged with the LLM. Matches the OpenAI-style
 * `{ role, content, tool_calls?, tool_call_id?, reasoning_content? }` shape
 * defined by the Inference Gateway schema.
 */
export type LLMMessage = SchemaMessage;

/**
 * A tool definition advertised to the model. The wire shape is
 * `{ type: 'function', function: { name, description?, parameters?, strict } }`.
 */
export type LLMTool = SchemaChatCompletionTool;

/**
 * A single tool invocation produced by the model. `function.arguments` is a
 * JSON-encoded string; the model may emit invalid JSON, so callers should
 * validate before parsing.
 */
export type LLMToolCall = SchemaChatCompletionMessageToolCall;

/**
 * Full chat completion response (non-streaming). Mirrors OpenAI's
 * `/v1/chat/completions` response. Use {@link OpenAICompatibleLLMClient.extractUsage}
 * to convert the snake_case `usage` field to a camelCase {@link LLMUsage}.
 */
export type LLMResponse = SchemaCreateChatCompletionResponse;

/**
 * A single chunk of a streaming chat completion response. The `choices[].delta`
 * carries incremental content / tool-call fragments; the final chunk's `usage`
 * field carries the request-level token totals when
 * `stream_options.include_usage` is set (which the SDK enables automatically).
 */
export type LLMStreamChunk = SchemaCreateChatCompletionStreamResponse;

/**
 * Raw upstream usage shape, with snake_case keys preserved from the wire
 * format. {@link LLMUsage} is the camelCase normalized form.
 */
export type LLMRawUsage = SchemaCompletionUsage;

/**
 * Token usage for a single LLM request, in camelCase. Returned by
 * {@link OpenAICompatibleLLMClient.extractUsage}.
 */
export interface LLMUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}
