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
import { TASK_STATE, isTerminal, type ManagedTask } from '../agent/task.js';
import type { Message, Struct } from '../types/generated/a2a.js';
import {
  DEFAULT_MAX_CONVERSATION_HISTORY,
  INPUT_REQUIRED_TOOL,
  UsageTracker,
  a2aMessageToChatMessage,
  assistantToChatMessage,
  buildAgentMessage,
  extractInputRequiredPrompt,
  resolveMaxIterations,
  type ChatMessage,
  type CompletionResult,
  type CreateCompletionOptions,
  type LLMClient,
  type ToolBox,
  type ToolCall,
} from './default-background-task-handler.js';
import type {
  StreamingExecutorContext,
  StreamingTaskEvent,
  StreamingTaskExecutor,
} from './message-stream.js';
import { NOOP_LOGGER, type Logger } from './server-builder.js';
import { createToolContext, drainPendingArtifacts } from './toolbox.js';

/** Constructor options for {@link DefaultStreamingTaskHandler}. */
export interface DefaultStreamingTaskHandlerOptions {
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
 * Streaming task handler that runs an LLM-driven agentic loop and emits a
 * CloudEvents stream of `adk.agent.delta`, `adk.agent.iteration.completed`,
 * `adk.agent.tool.{started,completed,failed,result}`,
 * `adk.agent.input.required`, and `adk.agent.task.status.changed` events as
 * the loop progresses.
 *
 * Mirrors the Go ADK's `OpenAICompatibleAgent.RunWithStream`
 * (`adk/server/agent_streamable.go`) and shares conversation handling,
 * iteration capping, and `input_required` interception with
 * {@link import('./default-background-task-handler.js').DefaultBackgroundTaskHandler}.
 * The two handlers differ only in how the agent loop surfaces progress: the
 * background handler aggregates state and returns the final task; this one
 * yields one {@link StreamingTaskEvent} per lifecycle step so the SSE
 * transport can flush each one to the client as it happens.
 *
 * Lifecycle per `handle()` invocation:
 *  1. Build the chat conversation from `context.task.messages`, truncate to
 *     `maxConversationHistory`, and prepend any configured system prompt.
 *  2. Call the LLM. Emit `delta` with the assistant text (when present),
 *     then `iterationCompleted`.
 *  3. If the response has no tool calls, the iteration is the last one - the
 *     streaming pipeline transitions the task to `COMPLETED` on natural
 *     completion of this generator.
 *  4. If any tool call has name {@link INPUT_REQUIRED_TOOL}, emit
 *     `toolStarted` + `toolCompleted` for it, then `inputRequiredNotice`
 *     carrying the prompt, then `iterationCompleted`, then `inputRequired` to
 *     transition the task to `INPUT_REQUIRED`. Stream ends.
 *  5. Otherwise, for every tool call: emit `toolStarted`, dispatch through the
 *     {@link ToolBox}, then `toolResult` + (`toolCompleted` | `toolFailed`).
 *     Feed the result back into the conversation and re-enter the loop.
 *  6. If the iteration cap is reached without completion, emit a terminal
 *     `statusChanged(FAILED, ...)` with a diagnostic message.
 *
 * Cancellation: when `context.signal` aborts the generator returns early
 * without yielding further events. The streaming pipeline then transitions
 * the task to `CANCELLED` and emits the final status frame.
 */
export class DefaultStreamingTaskHandler {
  private readonly llmClient: LLMClient;
  private readonly toolBox: ToolBox | undefined;
  private readonly logger: Logger;
  private readonly maxIterations: number;
  private readonly maxConversationHistory: number;
  private readonly systemPrompt: string | undefined;
  private readonly agentName: string;
  private readonly callbacks: Callbacks | undefined;
  private enableUsageMetadata = false;

  constructor(options: DefaultStreamingTaskHandlerOptions) {
    if (options.llmClient === undefined || options.llmClient === null) {
      throw new TypeError('DefaultStreamingTaskHandler requires an llmClient');
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
        'DefaultStreamingTaskHandler maxIterations must be a positive integer'
      );
    }
    if (this.maxConversationHistory <= 0) {
      throw new RangeError(
        'DefaultStreamingTaskHandler maxConversationHistory must be a positive integer'
      );
    }
    this.systemPrompt = options.systemPrompt;
    this.agentName = options.agentName ?? '';
    this.callbacks = options.callbacks;
  }

  /**
   * Toggle attaching token-usage / execution-stats to `task.metadata` when the
   * stream reaches a terminal state. Off by default. Parallel to
   * {@link import('./default-background-task-handler.js').DefaultBackgroundTaskHandler.setEnableUsageMetadata}.
   *
   * When on, the handler emits the accumulated counters via the optional
   * `metadata` field on the terminal `statusChanged` / `inputRequired` event;
   * the streaming pipeline shallow-merges them into `task.metadata` before
   * persisting the transition.
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
   * Adapter that returns the handler as a plain {@link StreamingTaskExecutor}
   * callable - useful for `builder.withStreamingTaskHandler(h.asHandler())`.
   */
  asHandler(): StreamingTaskExecutor {
    return (context) => this.handle(context);
  }

  /**
   * Drive the streaming task end-to-end. Yields {@link StreamingTaskEvent}
   * values for the pipeline to translate into CloudEvents frames. Honours
   * `context.signal` by returning early.
   */
  async *handle(
    context: StreamingExecutorContext
  ): AsyncGenerator<StreamingTaskEvent, void, void> {
    if (context.signal.aborted) {
      return;
    }
    if (isTerminal(context.task.state)) {
      return;
    }

    const tracker = new UsageTracker();
    const conversation: ChatMessage[] = this.buildInitialConversation(
      context.task
    );
    const toolState: Record<string, unknown> = {};
    const callbackContext: CallbackContext = {
      agentName: this.agentName,
      invocationId: crypto.randomUUID(),
      taskId: context.task.id,
      contextId: context.task.contextId,
      state: toolState,
      logger: this.logger,
      signal: context.signal,
    };

    const beforeAgentOverride = await runBeforeAgent(
      this.callbacks,
      callbackContext
    );
    if (beforeAgentOverride !== undefined) {
      yield { type: 'delta', message: beforeAgentOverride };
      const metadata = this.finalUsageMetadata(tracker);
      yield {
        type: 'statusChanged',
        state: TASK_STATE.COMPLETED,
        message: beforeAgentOverride,
        ...(metadata !== undefined ? { metadata } : {}),
      };
      return;
    }

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      if (context.signal.aborted) {
        return;
      }
      tracker.incrementIteration();

      const truncated = this.truncateConversation(conversation);
      const tools = this.toolBox?.getTools();
      this.logger.debug('streaming iteration starting', {
        iteration: iteration + 1,
        messages: truncated.length,
        tools: tools?.length ?? 0,
      });

      const beforeModelRequest = {
        messages: truncated,
        ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
      };
      const beforeModelOverride = await runBeforeModel(
        this.callbacks,
        callbackContext,
        beforeModelRequest
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
        try {
          result = await this.llmClient.createCompletion(completionOpts);
        } catch (err) {
          if (context.signal.aborted) {
            return;
          }
          throw err;
        }
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

      const text = assistant.content ?? '';
      if (text.length > 0) {
        const deltaMessage = buildAgentMessage(context.task, text);
        yield { type: 'delta', message: deltaMessage };
      }

      const toolCalls = assistant.toolCalls ?? [];

      if (toolCalls.length === 0) {
        const completionMessage = buildAgentMessage(
          context.task,
          text.length > 0 ? text : 'Done.'
        );
        const afterAgentOverride = await runAfterAgent(
          this.callbacks,
          callbackContext,
          completionMessage
        );
        const finalMessage = afterAgentOverride ?? completionMessage;
        if (afterAgentOverride !== undefined) {
          yield { type: 'delta', message: finalMessage };
        }
        yield {
          type: 'iterationCompleted',
          iteration: iteration + 1,
          message: finalMessage,
        };
        const metadata = this.finalUsageMetadata(tracker);
        if (metadata !== undefined) {
          yield {
            type: 'statusChanged',
            state: TASK_STATE.COMPLETED,
            message: finalMessage,
            metadata,
          };
        }
        return;
      }

      const inputRequired = toolCalls.find(
        (c) => c.name === INPUT_REQUIRED_TOOL
      );
      if (inputRequired !== undefined) {
        yield {
          type: 'toolStarted',
          toolCallId: inputRequired.id,
          toolName: inputRequired.name,
          arguments: inputRequired.arguments,
        };
        if (context.signal.aborted) {
          return;
        }
        yield {
          type: 'toolCompleted',
          toolCallId: inputRequired.id,
          toolName: inputRequired.name,
        };

        const prompt = extractInputRequiredPrompt(inputRequired.arguments);
        const promptMessage = buildAgentMessage(context.task, prompt);
        yield { type: 'inputRequiredNotice', message: promptMessage };
        yield {
          type: 'iterationCompleted',
          iteration: iteration + 1,
          message: promptMessage,
        };
        const metadata = this.finalUsageMetadata(tracker);
        yield {
          type: 'inputRequired',
          message: promptMessage,
          ...(metadata !== undefined ? { metadata } : {}),
        };
        return;
      }

      tracker.incrementToolCalls(toolCalls.length);
      if (this.toolBox === undefined) {
        this.logger.warn(
          'assistant returned tool calls but no toolBox is configured',
          { count: toolCalls.length }
        );
        tracker.incrementFailedTools(toolCalls.length);
        for (const call of toolCalls) {
          if (context.signal.aborted) {
            return;
          }
          yield {
            type: 'toolStarted',
            toolCallId: call.id,
            toolName: call.name,
            arguments: call.arguments,
          };
          const errMsg = `Tool "${call.name}" is not available: no toolBox configured.`;
          yield {
            type: 'toolFailed',
            toolCallId: call.id,
            toolName: call.name,
            error: errMsg,
          };
          yield {
            type: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            result: errMsg,
            isError: true,
          };
          conversation.push({
            role: 'tool',
            toolCallId: call.id,
            content: errMsg,
          });
        }
        yield { type: 'iterationCompleted', iteration: iteration + 1 };
        continue;
      }

      let lastAssistantMessage: Message | undefined;
      if (text.length > 0) {
        lastAssistantMessage = buildAgentMessage(context.task, text);
      }

      for (const call of toolCalls) {
        if (context.signal.aborted) {
          return;
        }
        yield {
          type: 'toolStarted',
          toolCallId: call.id,
          toolName: call.name,
          arguments: call.arguments,
        };
      }
      const dispatches = toolCalls.map((call) =>
        this.executeToolWithCallbacks(
          call,
          context.task,
          context.signal,
          toolState,
          callbackContext
        )
      );

      for (let i = 0; i < toolCalls.length; i++) {
        if (context.signal.aborted) {
          return;
        }
        const call = toolCalls[i] as ToolCall;
        const toolResult = (await dispatches[i]) as {
          readonly ok: boolean;
          readonly content: string;
        };
        if (context.signal.aborted) {
          return;
        }
        if (toolResult.ok) {
          yield {
            type: 'toolCompleted',
            toolCallId: call.id,
            toolName: call.name,
          };
        } else {
          tracker.incrementFailedTools();
          yield {
            type: 'toolFailed',
            toolCallId: call.id,
            toolName: call.name,
            error: toolResult.content,
          };
        }
        yield {
          type: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          result: toolResult.content,
          isError: !toolResult.ok,
        };
        conversation.push({
          role: 'tool',
          toolCallId: call.id,
          content: toolResult.content,
        });
      }

      for (const artifact of drainPendingArtifacts(toolState)) {
        yield { type: 'artifactCreated', artifact };
      }

      yield {
        type: 'iterationCompleted',
        iteration: iteration + 1,
        ...(lastAssistantMessage !== undefined
          ? { message: lastAssistantMessage }
          : {}),
      };
    }

    const failureMessage = buildAgentMessage(
      context.task,
      `Iteration cap reached (${this.maxIterations}) without completion.`
    );
    const failureMetadata = this.finalUsageMetadata(tracker);
    yield {
      type: 'statusChanged',
      state: TASK_STATE.FAILED,
      message: failureMessage,
      ...(failureMetadata !== undefined ? { metadata: failureMetadata } : {}),
    };
  }

  private finalUsageMetadata(tracker: UsageTracker): Struct | undefined {
    if (!this.enableUsageMetadata || !tracker.hasUsage()) {
      return undefined;
    }
    return tracker.getMetadata() as Struct;
  }

  private buildInitialConversation(task: ManagedTask): ChatMessage[] {
    if (isTerminal(task.state)) {
      return [];
    }
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
}
