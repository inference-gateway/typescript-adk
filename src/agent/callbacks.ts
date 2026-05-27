import type {
  AssistantMessage,
  ChatMessage,
  CompletionResult,
  ToolCall,
  ToolDefinition,
} from '../server/default-background-task-handler.js';
import type { Logger } from '../server/server-builder.js';
import type { Message } from '../types/generated/a2a.js';

/**
 * Context passed to every callback. Mirrors the Go ADK's `CallbackContext`
 * (`adk/server/callbacks.go`); uses TS-idiomatic shapes - an
 * {@link AbortSignal} for cancellation and a plain mutable `state` record for
 * session-scoped scratch data callbacks can read and write.
 *
 * The `state` reference is the same object the surrounding task handler hands
 * to every tool invocation in that handle() call, so a `beforeModel` callback
 * can stash data the next `beforeTool` callback (or a tool itself) reads.
 */
export interface CallbackContext {
  /** Name of the agent being executed. Empty when not configured. */
  readonly agentName: string;
  /** Uniquely identifies this execution invocation (one per handler call). */
  readonly invocationId: string;
  /** ID of the current task. */
  readonly taskId: string;
  /** Conversation context ID the task belongs to. */
  readonly contextId: string;
  /** Session state shared across callbacks and tools for this invocation. */
  readonly state: Record<string, unknown>;
  /** Structured logger scoped to the surrounding task handler. */
  readonly logger: Logger;
  /** Cancellation signal honored by the agent and its dispatched work. */
  readonly signal: AbortSignal;
}

/**
 * Snapshot of an LLM request inspected by {@link BeforeModelCallback}. The
 * shapes match what the surrounding task handler actually passes to the LLM
 * client - the conversation `messages` after history truncation and the
 * `tools` advertised on the request (when any). Both arrays are read-only; a
 * future iteration may allow `beforeModel` to mutate the request before it's
 * sent.
 */
export interface LLMRequest {
  /** Conversation forwarded to the LLM this iteration (after truncation). */
  readonly messages: readonly ChatMessage[];
  /** Tools advertised on this request, if any. */
  readonly tools?: readonly ToolDefinition[];
}

/**
 * Re-exported so consumers writing callbacks don't have to reach into the
 * server module for the shapes the callbacks receive and return.
 */
export type { AssistantMessage, CompletionResult, ToolCall };

/**
 * Called before the agent's main execution loop starts. Return a
 * {@link Message} to skip agent execution and use it as the final response;
 * return `undefined` (or omit a return) to proceed normally.
 *
 * When multiple `beforeAgent` callbacks are configured they run in order; the
 * first non-`undefined` return short-circuits the rest and is used as the
 * agent's final output. {@link AfterAgentCallback}s are NOT invoked when the
 * agent was short-circuited.
 */
export type BeforeAgentCallback = (
  context: CallbackContext
) => Message | undefined | Promise<Message | undefined>;

/**
 * Called after the agent's main execution completes. Not invoked when the
 * agent was short-circuited via {@link BeforeAgentCallback}. Return a
 * {@link Message} to replace the agent's output; `undefined` keeps it.
 *
 * When multiple `afterAgent` callbacks are configured they run in order and
 * each one sees the (possibly already-replaced) output from the previous
 * callback - the chain replaces incrementally rather than racing.
 */
export type AfterAgentCallback = (
  context: CallbackContext,
  output: Message
) => Message | undefined | Promise<Message | undefined>;

/**
 * Called just before each LLM request. Return an {@link CompletionResult} to skip
 * the LLM call (useful for caching / guardrails); `undefined` proceeds.
 *
 * First non-`undefined` return short-circuits both the LLM call and the
 * remaining `beforeModel` callbacks.
 */
export type BeforeModelCallback = (
  context: CallbackContext,
  request: LLMRequest
) => CompletionResult | undefined | Promise<CompletionResult | undefined>;

/**
 * Called just after each LLM response (including a synthetic one produced by
 * {@link BeforeModelCallback}). Return an {@link CompletionResult} to replace the
 * upstream response; `undefined` keeps it. Chains across multiple callbacks.
 */
export type AfterModelCallback = (
  context: CallbackContext,
  response: CompletionResult
) => CompletionResult | undefined | Promise<CompletionResult | undefined>;

/**
 * Called just before a tool is executed. Return a string to skip execution and
 * use the value as the tool result; `undefined` proceeds.
 *
 * First non-`undefined` return short-circuits both the tool dispatch and the
 * remaining `beforeTool` callbacks for that call. {@link AfterToolCallback}s
 * still run on the short-circuited result so logging / post-processing
 * remains uniform.
 */
export type BeforeToolCallback = (
  context: CallbackContext,
  toolCall: ToolCall
) => string | undefined | Promise<string | undefined>;

/**
 * Called just after a tool's execution completes. Return a string to replace
 * the tool result; `undefined` keeps the original. Chains across multiple
 * callbacks.
 */
export type AfterToolCallback = (
  context: CallbackContext,
  toolCall: ToolCall,
  result: string
) => string | undefined | Promise<string | undefined>;

/**
 * Lifecycle-callback configuration. All fields are optional - omit a field to
 * disable that hook. Each field accepts an array so multiple callbacks can be
 * composed at the same lifecycle point (executed in order; the first non-
 * `undefined` return short-circuits subsequent callbacks at that point).
 *
 * Callback errors are NOT caught by the framework - a thrown error in any
 * callback propagates out of the surrounding task handler, failing the task
 * with the error message. Catch inside the callback if you need to recover.
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

/**
 * Run every `beforeAgent` callback in order, returning the first non-
 * `undefined` value. Errors propagate.
 */
export async function runBeforeAgent(
  callbacks: Callbacks | undefined,
  context: CallbackContext
): Promise<Message | undefined> {
  const list = callbacks?.beforeAgent;
  if (list === undefined || list.length === 0) {
    return undefined;
  }
  for (const callback of list) {
    const result = await callback(context);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

/**
 * Run every `afterAgent` callback in order, chaining the (possibly replaced)
 * output through each. Returns the final replacement, or `undefined` if no
 * callback replaced the output.
 */
export async function runAfterAgent(
  callbacks: Callbacks | undefined,
  context: CallbackContext,
  output: Message
): Promise<Message | undefined> {
  const list = callbacks?.afterAgent;
  if (list === undefined || list.length === 0) {
    return undefined;
  }
  let current = output;
  let replaced: Message | undefined;
  for (const callback of list) {
    const result = await callback(context, current);
    if (result !== undefined) {
      current = result;
      replaced = result;
    }
  }
  return replaced;
}

/**
 * Run every `beforeModel` callback in order, returning the first non-
 * `undefined` value. Errors propagate.
 */
export async function runBeforeModel(
  callbacks: Callbacks | undefined,
  context: CallbackContext,
  request: LLMRequest
): Promise<CompletionResult | undefined> {
  const list = callbacks?.beforeModel;
  if (list === undefined || list.length === 0) {
    return undefined;
  }
  for (const callback of list) {
    const result = await callback(context, request);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

/**
 * Run every `afterModel` callback in order, chaining the (possibly replaced)
 * response through each. Returns the final replacement, or `undefined` if no
 * callback replaced the response.
 */
export async function runAfterModel(
  callbacks: Callbacks | undefined,
  context: CallbackContext,
  response: CompletionResult
): Promise<CompletionResult | undefined> {
  const list = callbacks?.afterModel;
  if (list === undefined || list.length === 0) {
    return undefined;
  }
  let current = response;
  let replaced: CompletionResult | undefined;
  for (const callback of list) {
    const result = await callback(context, current);
    if (result !== undefined) {
      current = result;
      replaced = result;
    }
  }
  return replaced;
}

/**
 * Run every `beforeTool` callback in order, returning the first non-
 * `undefined` value. Errors propagate.
 */
export async function runBeforeTool(
  callbacks: Callbacks | undefined,
  context: CallbackContext,
  toolCall: ToolCall
): Promise<string | undefined> {
  const list = callbacks?.beforeTool;
  if (list === undefined || list.length === 0) {
    return undefined;
  }
  for (const callback of list) {
    const result = await callback(context, toolCall);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

/**
 * Run every `afterTool` callback in order, chaining the (possibly replaced)
 * result through each. Returns the final replacement, or `undefined` if no
 * callback replaced the result.
 */
export async function runAfterTool(
  callbacks: Callbacks | undefined,
  context: CallbackContext,
  toolCall: ToolCall,
  result: string
): Promise<string | undefined> {
  const list = callbacks?.afterTool;
  if (list === undefined || list.length === 0) {
    return undefined;
  }
  let current = result;
  let replaced: string | undefined;
  for (const callback of list) {
    const next = await callback(context, toolCall, current);
    if (next !== undefined) {
      current = next;
      replaced = next;
    }
  }
  return replaced;
}
