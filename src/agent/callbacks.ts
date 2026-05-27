import type {
  LLMMessage,
  LLMResponse,
  LLMTool,
  LLMToolCall,
} from '../llm/types.js';
import type { Message } from '../types/generated/a2a.js';

/**
 * Context passed to every callback. Mirrors the Go ADK's `CallbackContext`
 * (`adk/server/callbacks.go`); uses TS-idiomatic shapes - an
 * {@link AbortSignal} for cancellation and a plain mutable `state` record for
 * session-scoped scratch data callbacks can read and write.
 */
export interface CallbackContext {
  /** Name of the agent being executed, when known. */
  readonly agentName?: string;
  /** Uniquely identifies this execution invocation. */
  readonly invocationId: string;
  /** ID of the current task, when available. */
  readonly taskId?: string;
  /** Conversation context ID, when available. */
  readonly contextId?: string;
  /** Session state shared across callbacks for the same invocation. */
  readonly state: Record<string, unknown>;
  /** Cancellation signal honored by the agent and its dispatched work. */
  readonly signal: AbortSignal;
}

/**
 * Subset of an LLM request inspected (and optionally modified) by
 * {@link BeforeModelCallback} / {@link AfterModelCallback}. Currently
 * read-only - callbacks that need to mutate the request will be supported in a
 * later iteration once the agent's run loop is wired up.
 */
export interface LLMRequest {
  /** Messages being sent to the LLM. */
  readonly messages: readonly LLMMessage[];
  /** Tools advertised on this request, if any. */
  readonly tools?: readonly LLMTool[];
  /** System prompt, when set. */
  readonly systemPrompt?: string;
  /** Sampling temperature, when set. */
  readonly temperature?: number;
  /** Top-p sampling, when set. */
  readonly topP?: number;
  /** Max tokens per response, when set. */
  readonly maxTokens?: number;
}

/**
 * Called before the agent's main execution loop starts. Return a
 * {@link Message} to skip agent execution and use it as the final response;
 * return `undefined` (or omit a return) to proceed normally.
 */
export type BeforeAgentCallback = (
  context: CallbackContext
) => Message | undefined | Promise<Message | undefined>;

/**
 * Called after the agent's main execution completes. Not invoked when the
 * agent was short-circuited via {@link BeforeAgentCallback}. Return a
 * {@link Message} to replace the agent's output; `undefined` keeps it.
 */
export type AfterAgentCallback = (
  context: CallbackContext,
  output: Message
) => Message | undefined | Promise<Message | undefined>;

/**
 * Called just before each LLM request. Return an {@link LLMResponse} to skip
 * the LLM call (useful for caching / guardrails); `undefined` proceeds.
 */
export type BeforeModelCallback = (
  context: CallbackContext,
  request: LLMRequest
) => LLMResponse | undefined | Promise<LLMResponse | undefined>;

/**
 * Called just after each LLM response. Return an {@link LLMResponse} to
 * replace the upstream response; `undefined` keeps it.
 */
export type AfterModelCallback = (
  context: CallbackContext,
  response: LLMResponse
) => LLMResponse | undefined | Promise<LLMResponse | undefined>;

/**
 * Called just before a tool is executed. Return a string to skip execution and
 * use the value as the tool result; `undefined` proceeds.
 */
export type BeforeToolCallback = (
  context: CallbackContext,
  toolCall: LLMToolCall
) => string | undefined | Promise<string | undefined>;

/**
 * Called just after a tool's execution completes. Return a string to replace
 * the tool result; `undefined` keeps the original.
 */
export type AfterToolCallback = (
  context: CallbackContext,
  toolCall: LLMToolCall,
  result: string
) => string | undefined | Promise<string | undefined>;

/**
 * Lifecycle-callback configuration. All fields are optional - omit a field to
 * disable that hook. Each field accepts an array so multiple callbacks can be
 * composed at the same lifecycle point (executed in order; the first non-
 * `undefined` return short-circuits subsequent callbacks at that point).
 *
 * Mirrors the Go ADK's `CallbackConfig` (`adk/server/callbacks.go`).
 */
export interface Callbacks {
  readonly beforeAgent?: readonly BeforeAgentCallback[];
  readonly afterAgent?: readonly AfterAgentCallback[];
  readonly beforeModel?: readonly BeforeModelCallback[];
  readonly afterModel?: readonly AfterModelCallback[];
  readonly beforeTool?: readonly BeforeToolCallback[];
  readonly afterTool?: readonly AfterToolCallback[];
}
