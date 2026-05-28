import {
  runAfterAgent,
  runAfterModel,
  runAfterTool,
  runBeforeAgent,
  runBeforeModel,
  runBeforeTool,
  type CallbackContext,
  type Callbacks,
} from '../agent/callbacks.js';
import {
  TASK_STATE,
  isTerminal,
  transitionTask,
  type ManagedTask,
} from '../agent/task.js';
import type {
  Artifact,
  Message,
  Part,
  Struct,
} from '../types/generated/a2a.js';
import { NOOP_LOGGER, type Logger } from './server-builder.js';
import type {
  BackgroundTaskContext,
  BackgroundTaskHandler,
} from './server-builder.js';
import {
  INPUT_REQUIRED_TOOL,
  createToolContext,
  drainPendingArtifacts,
  type ToolBox,
  type ToolDefinition,
} from './toolbox.js';

/**
 * Re-exported from {@link './toolbox.js'} so callers wiring a handler do not
 * need to import the reserved-tool constant from two modules. The canonical
 * definition lives in `toolbox.ts`.
 */
export { INPUT_REQUIRED_TOOL };

/**
 * Name of the environment variable that overrides the iteration cap. Must
 * parse as a positive integer; non-positive or non-numeric values fall back to
 * {@link DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS}.
 */
export const MAX_CHAT_COMPLETION_ITERATIONS_ENV =
  'MAX_CHAT_COMPLETION_ITERATIONS';

/**
 * Default iteration cap when no explicit value or env var is supplied. Matches
 * the Go ADK default in `server/config/config.go`.
 */
export const DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS = 50;

/**
 * Default upper bound on conversation messages forwarded to the LLM per
 * iteration. Older messages are dropped (oldest first) once the conversation
 * exceeds this length.
 */
export const DEFAULT_MAX_CONVERSATION_HISTORY = 20;

/**
 * Re-export so callers wiring a handler can pull the LLM-facing tool
 * definition from one place. The canonical declaration lives in
 * `toolbox.ts`.
 */
export type { ToolDefinition };

/**
 * A single tool call requested by the assistant in an LLM response. The
 * `arguments` field is a stringified JSON blob (OpenAI convention).
 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** Token-usage tuple returned by an LLM completion. */
export interface CompletionUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens?: number;
}

/** Assistant message returned by a single LLM completion call. */
export interface AssistantMessage {
  readonly content?: string;
  readonly toolCalls?: readonly ToolCall[];
}

/** Result of one LLM completion call. */
export interface CompletionResult {
  readonly message: AssistantMessage;
  readonly usage?: CompletionUsage;
}

/**
 * Single message in an OpenAI-style chat conversation. The handler accumulates
 * these across iterations as it dispatches tool calls and feeds the results
 * back to the model.
 */
export type ChatMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content?: string;
      readonly toolCalls?: readonly ToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly content: string;
      readonly toolCallId: string;
    };

/** Arguments accepted by {@link LLMClient.createCompletion}. */
export interface CreateCompletionOptions {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly signal?: AbortSignal;
}

/**
 * Minimal OpenAI-compatible chat-completion client used by the handler. A
 * concrete implementation backed by the Inference Gateway / OpenAI HTTP API
 * lands separately (see issue #27); the handler only depends on this
 * structural interface.
 */
export interface LLMClient {
  createCompletion(options: CreateCompletionOptions): Promise<CompletionResult>;
}

/**
 * Re-exported from {@link './toolbox.js'} so callers that only depend on the
 * handler surface still pick up the canonical {@link ToolBox} interface.
 */
export type { ToolBox };

/**
 * Token-usage and execution-statistics accumulator. Mirrors the Go ADK's
 * `UsageTracker`. Public so tests and downstream tooling can inspect the
 * snapshot directly; the handler attaches `getMetadata()` to `task.metadata`
 * when {@link DefaultBackgroundTaskHandler.setEnableUsageMetadata} is on.
 */
export class UsageTracker {
  private promptTokens = 0;
  private completionTokens = 0;
  private totalTokens = 0;
  private iterations = 0;
  private toolCalls = 0;
  private failedTools = 0;
  private llmCalls = 0;

  addUsage(usage: CompletionUsage): void {
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.totalTokens +=
      usage.totalTokens ?? usage.promptTokens + usage.completionTokens;
    this.llmCalls++;
  }

  incrementIteration(): void {
    this.iterations++;
  }

  incrementToolCalls(count = 1): void {
    this.toolCalls += count;
  }

  incrementFailedTools(count = 1): void {
    this.failedTools += count;
  }

  hasUsage(): boolean {
    return this.llmCalls > 0 || this.iterations > 0 || this.toolCalls > 0;
  }

  getMetadata(): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      execution_stats: {
        iterations: this.iterations,
        tool_calls: this.toolCalls,
        failed_tools: this.failedTools,
      },
    };
    if (this.llmCalls > 0) {
      metadata['usage'] = {
        prompt_tokens: this.promptTokens,
        completion_tokens: this.completionTokens,
        total_tokens: this.totalTokens,
      };
    }
    return metadata;
  }
}

/** Constructor options for {@link DefaultBackgroundTaskHandler}. */
export interface DefaultBackgroundTaskHandlerOptions {
  /** LLM client used to drive the completion loop. Required. */
  readonly llmClient: LLMClient;
  /**
   * Tool registry consulted on every iteration. Optional - without one the
   * handler runs a tool-free completion loop and stops after the first
   * assistant message.
   */
  readonly toolBox?: ToolBox;
  /** Structural logger. Defaults to {@link NOOP_LOGGER}. */
  readonly logger?: Logger;
  /**
   * Override the iteration cap. When omitted the handler reads
   * {@link MAX_CHAT_COMPLETION_ITERATIONS_ENV} from {@link options.env},
   * falling back to {@link DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS}.
   */
  readonly maxIterations?: number;
  /**
   * Upper bound on the number of conversation messages forwarded to the LLM
   * each iteration. Defaults to {@link DEFAULT_MAX_CONVERSATION_HISTORY}. The
   * system prompt (when present) is always preserved on top of the budget.
   */
  readonly maxConversationHistory?: number;
  /**
   * Optional system prompt prepended to every LLM call. Not counted against
   * {@link maxConversationHistory}.
   */
  readonly systemPrompt?: string;
  /**
   * Optional name of the agent running these tasks. Forwarded to every
   * {@link import('./toolbox.js').ToolContext} so tools can attribute their
   * work. Defaults to the empty string.
   */
  readonly agentName?: string;
  /**
   * Optional lifecycle callbacks invoked around the agent run, every LLM call,
   * and every tool dispatch. See {@link import('../agent/callbacks.js').Callbacks}
   * for the hook points and short-circuit semantics.
   */
  readonly callbacks?: Callbacks;
  /**
   * Read environment variables from this object instead of `process.env`.
   * Test seam.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Background task handler that runs an LLM-driven agentic loop with automatic
 * conversation-history management, tool dispatch, an iteration cap, and
 * optional usage-metadata accumulation.
 *
 * Mirrors the Go ADK's `DefaultBackgroundTaskHandler`
 * (`adk/server/task_handler.go`). The TS variant inlines the iteration loop
 * (which the Go variant delegates to `OpenAICompatibleAgent.RunWithStream`)
 * because the early-bootstrap TS surface does not yet ship a stream-based
 * agent abstraction.
 *
 * Lifecycle per `handle()` call:
 *  1. Build the chat conversation from `task.messages`, truncate to
 *     `maxConversationHistory`, and prepend any configured system prompt.
 *  2. Call the LLM. If the response contains no tool calls, append the
 *     assistant text to `task.messages`, transition to `COMPLETED`, return.
 *  3. If any tool call has name {@link INPUT_REQUIRED_TOOL}, append the
 *     prompt to `task.messages`, transition to `INPUT_REQUIRED`, and return -
 *     no further tools are executed in that iteration.
 *  4. Otherwise dispatch every tool call through the configured
 *     {@link ToolBox}, append the assistant tool-call message and each tool
 *     result to the conversation, and re-enter the loop.
 *  5. If the iteration cap is hit before completion, transition the task to
 *     `FAILED` with a diagnostic message.
 *
 * Tool execution errors are caught and reported back to the model as a `tool`
 * message containing the error text - the loop continues so the model can
 * recover or surface a user-facing error.
 *
 * Concrete `LLMClient` and `ToolBox` implementations land in issues #27 and
 * #31 respectively; this handler only depends on the structural interfaces.
 */
export class DefaultBackgroundTaskHandler {
  private readonly llmClient: LLMClient;
  private readonly toolBox: ToolBox | undefined;
  private readonly logger: Logger;
  private readonly maxIterations: number;
  private readonly maxConversationHistory: number;
  private readonly systemPrompt: string | undefined;
  private readonly agentName: string;
  private readonly callbacks: Callbacks | undefined;
  private enableUsageMetadata = false;

  constructor(options: DefaultBackgroundTaskHandlerOptions) {
    if (options.llmClient === undefined || options.llmClient === null) {
      throw new TypeError('DefaultBackgroundTaskHandler requires an llmClient');
    }
    this.llmClient = options.llmClient;
    this.toolBox = options.toolBox;
    this.logger = options.logger ?? NOOP_LOGGER;
    const env = options.env ?? process.env;
    this.maxIterations = options.maxIterations ?? resolveMaxIterations(env);
    this.maxConversationHistory =
      options.maxConversationHistory ?? DEFAULT_MAX_CONVERSATION_HISTORY;
    if (this.maxIterations <= 0) {
      throw new RangeError(
        'DefaultBackgroundTaskHandler maxIterations must be a positive integer'
      );
    }
    if (this.maxConversationHistory <= 0) {
      throw new RangeError(
        'DefaultBackgroundTaskHandler maxConversationHistory must be a positive integer'
      );
    }
    this.systemPrompt = options.systemPrompt;
    this.agentName = options.agentName ?? '';
    this.callbacks = options.callbacks;
  }

  /**
   * Toggle attaching token-usage / execution-stats to `task.metadata` on
   * terminal transitions. Off by default.
   */
  setEnableUsageMetadata(enabled: boolean): void {
    this.enableUsageMetadata = enabled;
  }

  /** Reports whether usage metadata is currently enabled. */
  isUsageMetadataEnabled(): boolean {
    return this.enableUsageMetadata;
  }

  /** Configured iteration cap. Useful for diagnostics and tests. */
  getMaxIterations(): number {
    return this.maxIterations;
  }

  /** Configured conversation-history truncation. */
  getMaxConversationHistory(): number {
    return this.maxConversationHistory;
  }

  /**
   * Adapter that returns the handler as a plain {@link BackgroundTaskHandler}
   * callable - useful for `builder.withBackgroundTaskHandler(h.asHandler())`
   * since the builder consumes a function reference rather than an instance.
   */
  asHandler(): BackgroundTaskHandler {
    return (context) => this.handle(context);
  }

  /**
   * Process one background task end-to-end. Always resolves with the updated
   * task; never rejects. Aborts honor `context.signal` by transitioning the
   * task to `CANCELLED`.
   */
  async handle(context: BackgroundTaskContext): Promise<ManagedTask> {
    let task = context.task;
    if (isTerminal(task.state)) {
      return task;
    }
    if (task.state === TASK_STATE.PENDING) {
      task = transitionTask(task, TASK_STATE.IN_PROGRESS);
    }

    const tracker = new UsageTracker();
    const conversation: ChatMessage[] = this.buildInitialConversation(task);
    const toolState: Record<string, unknown> = {};
    const accumulatedArtifacts: Artifact[] = [];
    const callbackContext = this.buildCallbackContext(
      task,
      context.signal,
      toolState
    );

    try {
      const override = await runBeforeAgent(this.callbacks, callbackContext);
      if (override !== undefined) {
        accumulatedArtifacts.push(...drainPendingArtifacts(toolState));
        return this.finalizeWithMessage(
          task,
          override,
          tracker,
          accumulatedArtifacts
        );
      }

      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        if (context.signal.aborted) {
          accumulatedArtifacts.push(...drainPendingArtifacts(toolState));
          return this.finalizeCancelled(task, tracker, accumulatedArtifacts);
        }
        tracker.incrementIteration();

        const truncated = this.truncateConversation(conversation);
        const tools = this.toolBox?.getTools();
        this.logger.debug('llm iteration starting', {
          iteration: iteration + 1,
          messages: truncated.length,
          tools: tools?.length ?? 0,
        });

        const request = {
          messages: truncated,
          ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
        };
        const beforeModelOverride = await runBeforeModel(
          this.callbacks,
          callbackContext,
          request
        );
        let result: CompletionResult;
        if (beforeModelOverride !== undefined) {
          result = beforeModelOverride;
        } else {
          const completionOpts: CreateCompletionOptions = {
            messages: truncated,
            signal: context.signal,
            ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
          };
          result = await this.llmClient.createCompletion(completionOpts);
        }
        const afterModelOverride = await runAfterModel(
          this.callbacks,
          callbackContext,
          result
        );
        if (afterModelOverride !== undefined) {
          result = afterModelOverride;
        }
        if (result.usage !== undefined) {
          tracker.addUsage(result.usage);
        }
        const assistant = result.message;
        conversation.push(assistantToChatMessage(assistant));

        const toolCalls = assistant.toolCalls ?? [];
        if (toolCalls.length === 0) {
          accumulatedArtifacts.push(...drainPendingArtifacts(toolState));
          return await this.finalizeCompletedWithCallbacks(
            task,
            assistant,
            tracker,
            callbackContext,
            accumulatedArtifacts
          );
        }

        const inputRequired = toolCalls.find(
          (c) => c.name === INPUT_REQUIRED_TOOL
        );
        if (inputRequired !== undefined) {
          accumulatedArtifacts.push(...drainPendingArtifacts(toolState));
          return this.finalizeInputRequired(
            task,
            inputRequired,
            tracker,
            accumulatedArtifacts
          );
        }

        tracker.incrementToolCalls(toolCalls.length);
        if (this.toolBox === undefined) {
          this.logger.warn(
            'assistant returned tool calls but no toolBox is configured',
            { count: toolCalls.length }
          );
          tracker.incrementFailedTools(toolCalls.length);
          for (const call of toolCalls) {
            conversation.push({
              role: 'tool',
              toolCallId: call.id,
              content: `Tool "${call.name}" is not available: no toolBox configured.`,
            });
          }
          continue;
        }

        // Dispatch every tool call from this iteration concurrently. Results
        // are awaited in submission order so the assistant sees them in the
        // same order it produced the calls.
        const dispatches = toolCalls.map((call) =>
          this.executeToolWithCallbacks(
            call,
            task,
            context.signal,
            toolState,
            callbackContext
          )
        );
        const results = await Promise.all(dispatches);
        if (context.signal.aborted) {
          accumulatedArtifacts.push(...drainPendingArtifacts(toolState));
          return this.finalizeCancelled(task, tracker, accumulatedArtifacts);
        }
        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i] as ToolCall;
          const toolResult = results[i] as {
            readonly ok: boolean;
            readonly content: string;
          };
          if (!toolResult.ok) {
            tracker.incrementFailedTools();
          }
          conversation.push({
            role: 'tool',
            toolCallId: call.id,
            content: toolResult.content,
          });
        }
        accumulatedArtifacts.push(...drainPendingArtifacts(toolState));
      }

      return this.finalizeFailed(
        task,
        `Iteration cap reached (${this.maxIterations}) without completion.`,
        tracker,
        accumulatedArtifacts
      );
    } catch (err) {
      accumulatedArtifacts.push(...drainPendingArtifacts(toolState));
      if (context.signal.aborted) {
        return this.finalizeCancelled(task, tracker, accumulatedArtifacts);
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('background task failed', { error: message });
      return this.finalizeFailed(task, message, tracker, accumulatedArtifacts);
    }
  }

  private buildCallbackContext(
    task: ManagedTask,
    signal: AbortSignal,
    state: Record<string, unknown>
  ): CallbackContext {
    return {
      agentName: this.agentName,
      invocationId: crypto.randomUUID(),
      taskId: task.id,
      contextId: task.contextId,
      state,
      logger: this.logger,
      signal,
    };
  }

  private async finalizeCompletedWithCallbacks(
    task: ManagedTask,
    assistant: AssistantMessage,
    tracker: UsageTracker,
    callbackContext: CallbackContext,
    artifacts: readonly Artifact[]
  ): Promise<ManagedTask> {
    const text = assistant.content ?? '';
    const message = buildAgentMessage(task, text.length > 0 ? text : 'Done.');
    const override = await runAfterAgent(
      this.callbacks,
      callbackContext,
      message
    );
    const finalMessage = override ?? message;
    return this.finalizeWithMessage(task, finalMessage, tracker, artifacts);
  }

  private finalizeWithMessage(
    task: ManagedTask,
    message: Message,
    tracker: UsageTracker,
    artifacts: readonly Artifact[] = []
  ): ManagedTask {
    const withMessage: ManagedTask = {
      ...task,
      messages: [...task.messages, message],
      ...(artifacts.length > 0
        ? { artifacts: [...task.artifacts, ...artifacts] }
        : {}),
    };
    const next = transitionTask(withMessage, TASK_STATE.COMPLETED, { message });
    return this.attachMetadata(next, tracker);
  }

  private async executeToolWithCallbacks(
    call: ToolCall,
    task: ManagedTask,
    signal: AbortSignal,
    state: Record<string, unknown>,
    callbackContext: CallbackContext
  ): Promise<{ readonly ok: boolean; readonly content: string }> {
    const before = await runBeforeTool(this.callbacks, callbackContext, call);
    let result: { readonly ok: boolean; readonly content: string };
    if (before !== undefined) {
      result = { ok: true, content: before };
    } else {
      result = await this.executeTool(call, task, signal, state);
    }
    const after = await runAfterTool(
      this.callbacks,
      callbackContext,
      call,
      result.content
    );
    if (after !== undefined) {
      return { ok: result.ok, content: after };
    }
    return result;
  }

  private buildInitialConversation(task: ManagedTask): ChatMessage[] {
    const conversation: ChatMessage[] = [];
    if (this.systemPrompt !== undefined && this.systemPrompt.length > 0) {
      conversation.push({ role: 'system', content: this.systemPrompt });
    }
    for (const message of task.messages) {
      const chat = a2aMessageToChatMessage(message);
      if (chat !== undefined) {
        conversation.push(chat);
      }
    }
    return conversation;
  }

  private truncateConversation(
    conversation: readonly ChatMessage[]
  ): ChatMessage[] {
    const hasSystem =
      conversation.length > 0 && conversation[0]?.role === 'system';
    const systemPart = hasSystem ? [conversation[0] as ChatMessage] : [];
    const rest = hasSystem ? conversation.slice(1) : [...conversation];
    if (rest.length <= this.maxConversationHistory) {
      return [...systemPart, ...rest];
    }
    return [
      ...systemPart,
      ...rest.slice(rest.length - this.maxConversationHistory),
    ];
  }

  private async executeTool(
    call: ToolCall,
    task: ManagedTask,
    signal: AbortSignal,
    state: Record<string, unknown>
  ): Promise<{ readonly ok: boolean; readonly content: string }> {
    if (this.toolBox === undefined) {
      return {
        ok: false,
        content: `Tool "${call.name}" is not available: no toolBox configured.`,
      };
    }
    try {
      const content = await this.toolBox.executeTool(
        call.name,
        call.arguments,
        createToolContext({
          task,
          invocationId: call.id,
          signal,
          state,
          agentName: this.agentName,
          logger: this.logger,
        })
      );
      return { ok: true, content };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('tool execution failed', {
        tool: call.name,
        error: message,
      });
      return {
        ok: false,
        content: `Error executing tool "${call.name}": ${message}`,
      };
    }
  }

  private finalizeInputRequired(
    task: ManagedTask,
    call: ToolCall,
    tracker: UsageTracker,
    artifacts: readonly Artifact[] = []
  ): ManagedTask {
    const prompt = extractInputRequiredPrompt(call.arguments);
    const message = buildAgentMessage(task, prompt);
    const withMessage: ManagedTask = {
      ...task,
      messages: [...task.messages, message],
      ...(artifacts.length > 0
        ? { artifacts: [...task.artifacts, ...artifacts] }
        : {}),
    };
    const next = transitionTask(withMessage, TASK_STATE.INPUT_REQUIRED, {
      message,
    });
    return this.attachMetadata(next, tracker);
  }

  private finalizeFailed(
    task: ManagedTask,
    text: string,
    tracker: UsageTracker,
    artifacts: readonly Artifact[] = []
  ): ManagedTask {
    const baseTask = isTerminal(task.state)
      ? task
      : task.state === TASK_STATE.PENDING
        ? transitionTask(task, TASK_STATE.IN_PROGRESS)
        : task;
    if (isTerminal(baseTask.state)) {
      return baseTask;
    }
    const message = buildAgentMessage(baseTask, text);
    const withArtifacts: ManagedTask =
      artifacts.length > 0
        ? { ...baseTask, artifacts: [...baseTask.artifacts, ...artifacts] }
        : baseTask;
    const next = transitionTask(withArtifacts, TASK_STATE.FAILED, { message });
    return this.attachMetadata(next, tracker);
  }

  private finalizeCancelled(
    task: ManagedTask,
    tracker: UsageTracker,
    artifacts: readonly Artifact[] = []
  ): ManagedTask {
    if (isTerminal(task.state)) {
      return task;
    }
    const message = buildAgentMessage(task, 'Task cancelled.');
    const withArtifacts: ManagedTask =
      artifacts.length > 0
        ? { ...task, artifacts: [...task.artifacts, ...artifacts] }
        : task;
    const next = transitionTask(withArtifacts, TASK_STATE.CANCELLED, {
      message,
    });
    return this.attachMetadata(next, tracker);
  }

  private attachMetadata(
    task: ManagedTask,
    tracker: UsageTracker
  ): ManagedTask {
    if (!this.enableUsageMetadata || !tracker.hasUsage()) {
      return task;
    }
    const merged: Struct = {
      ...((task.metadata ?? {}) as Record<string, unknown>),
      ...tracker.getMetadata(),
    };
    return { ...task, metadata: merged };
  }
}

export function assistantToChatMessage(message: AssistantMessage): ChatMessage {
  return {
    role: 'assistant',
    ...(message.content !== undefined ? { content: message.content } : {}),
    ...(message.toolCalls !== undefined && message.toolCalls.length > 0
      ? { toolCalls: message.toolCalls }
      : {}),
  };
}

export function a2aMessageToChatMessage(
  message: Message
): ChatMessage | undefined {
  const text = extractText(message.parts);
  if (text.length === 0) {
    return undefined;
  }
  if (message.role === 'ROLE_USER') {
    return { role: 'user', content: text };
  }
  if (message.role === 'ROLE_AGENT') {
    return { role: 'assistant', content: text };
  }
  return undefined;
}

function extractText(parts: readonly Part[] | undefined): string {
  if (parts === undefined) {
    return '';
  }
  return parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter((segment) => segment.length > 0)
    .join('\n');
}

export function buildAgentMessage(task: ManagedTask, text: string): Message {
  return {
    messageId: crypto.randomUUID(),
    role: 'ROLE_AGENT',
    contextId: task.contextId,
    taskId: task.id,
    parts: [{ text }],
  };
}

export function extractInputRequiredPrompt(rawArgs: string): string {
  if (typeof rawArgs !== 'string' || rawArgs.length === 0) {
    return 'Additional input required.';
  }
  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['message', 'prompt', 'question'] as const) {
        const value = obj[key];
        if (typeof value === 'string' && value.length > 0) {
          return value;
        }
      }
    }
  } catch {
    // Fall through to default below; non-JSON args are still surfaced verbatim.
    return rawArgs;
  }
  return 'Additional input required.';
}

export function resolveMaxIterations(
  env: Readonly<Record<string, string | undefined>>
): number {
  const raw = env[MAX_CHAT_COMPLETION_ITERATIONS_ENV];
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS;
  }
  return parsed;
}
