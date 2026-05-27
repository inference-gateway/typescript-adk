import { loadAgentCardFromFile } from '../agent/card.js';
import {
  TASK_STATE,
  isTerminal,
  transitionTask,
  type ManagedTask,
} from '../agent/task.js';
import { InMemoryTaskStorage } from '../storage/in-memory.js';
import type { TaskStorage } from '../storage/task-storage.js';
import type { AgentCard, Message } from '../types/generated/a2a.js';
import {
  MESSAGE_SEND_METHOD,
  createMessageSendHandler,
} from './message-send.js';
import {
  MESSAGE_STREAM_METHOD,
  createMessageStreamHandler,
  type StreamingExecutorContext,
  type StreamingTaskEvent,
  type StreamingTaskExecutor,
} from './message-stream.js';
import { A2AServer, type A2AServerConfig } from './server.js';
import { TASK_CANCEL_METHOD, createTaskCancelHandler } from './task-cancel.js';
import { TaskCancellationRegistry } from './task-cancellation.js';
import { TaskEventBusRegistry } from './task-event-bus.js';
import type {
  StreamableTaskHandler,
  TaskHandler,
  TaskHandlerContext,
} from './task-handler.js';
import {
  TASK_RESUBSCRIBE_METHOD,
  createTaskResubscribeHandler,
} from './task-resubscribe.js';

/**
 * Structural logger interface. Compatible with `console`, `pino`, the standard
 * shape of `zap`-style wrappers, etc. The builder calls these synchronously
 * with a short message and any number of trailing arguments; each
 * implementation is free to format them however it likes.
 */
export interface Logger {
  debug(message: string, ...args: readonly unknown[]): void;
  info(message: string, ...args: readonly unknown[]): void;
  warn(message: string, ...args: readonly unknown[]): void;
  error(message: string, ...args: readonly unknown[]): void;
}

/**
 * No-op logger used when the builder is constructed without one. Drops every
 * call. Exported so tests and callers can install it explicitly.
 */
export const NOOP_LOGGER: Logger = Object.freeze({
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
});

function noop(): void {
  // intentionally empty
}

/**
 * Marker interface for an OpenAI-compatible LLM agent. The concrete agent
 * implementation lives in a future iteration (mirrors the Go ADK's
 * `OpenAICompatibleAgent`); the builder accepts and stores an instance but
 * does not invoke it yet.
 */
export interface OpenAICompatibleAgent {
  /** Stable identifier (model name, etc.). Used for diagnostics only. */
  readonly id: string;
}

/**
 * Marker interface for an artifact-storage service. Concrete service
 * implementations live in a future iteration (mirrors the Go ADK's
 * `ArtifactService`).
 */
export interface ArtifactService {
  /** Stable identifier; used for diagnostics. */
  readonly name: string;
}

/**
 * Post-processor invoked once a background task reaches a candidate terminal
 * state. Returning a new {@link ManagedTask} replaces the persisted task;
 * returning the input unchanged is a no-op. Mirrors the Go ADK's
 * `TaskResultProcessor` concept where tool-call results can short-circuit
 * task completion.
 */
export interface TaskResultProcessor {
  process(task: ManagedTask): Promise<ManagedTask> | ManagedTask;
}

/** Context handed to a {@link BackgroundTaskHandler} on each invocation. */
export interface BackgroundTaskContext {
  readonly task: ManagedTask;
  readonly message: Message;
  readonly signal: AbortSignal;
}

/**
 * Background task handler - invoked by a worker after a `message/send` task
 * is dequeued. Returns the updated task (typically in a terminal state).
 *
 * The actual worker that dequeues tasks and invokes handlers is not yet wired
 * into the server; the builder stores the handler so a future worker
 * iteration can pick it up. Validation that *a* handler exists still happens
 * at {@link A2AServerBuilder.build}.
 */
export type BackgroundTaskHandler = (
  context: BackgroundTaskContext
) => Promise<ManagedTask> | ManagedTask;

/**
 * Streaming task handler. Alias of {@link StreamingTaskExecutor} so callers
 * configuring the builder don't have to reach into `./message-stream.js` for
 * the type. The builder hands this directly to
 * {@link createMessageStreamHandler} at build time.
 */
export type StreamingTaskHandler = StreamingTaskExecutor;

/**
 * Configuration accepted by the {@link A2AServerBuilder} constructor. All
 * fields are optional; sensible defaults are populated by `build()`.
 */
export interface A2AServerBuilderConfig {
  /**
   * Override the storage backend. Defaults to a fresh
   * {@link InMemoryTaskStorage} created during `build()`.
   */
  readonly storage?: TaskStorage;
  /**
   * Override the JSON-RPC mount path passed to {@link A2AServer}. Defaults to
   * the server default (`'/'`).
   */
  readonly jsonRpcPath?: string;
  /**
   * Override the agent card `Cache-Control` header passed to {@link A2AServer}.
   */
  readonly cacheControl?: string;
}

/**
 * Thrown by {@link A2AServerBuilder.build} when required pieces are missing -
 * no agent card, no task handlers, or a handler/capability mismatch (e.g.,
 * streaming capability advertised but no streaming handler configured).
 */
export class A2AServerBuilderError extends Error {
  override readonly name = 'A2AServerBuilderError';
}

/**
 * Fluent builder that wires the pieces of an A2A server together - handlers,
 * agent, agent card, logger, and services - and validates the result at
 * `build()` time.
 *
 * Phantom type parameters track whether mandatory pieces have been supplied so
 * omitting them surfaces as a compile-time error on `build()`:
 *
 * ```ts
 * new A2AServerBuilder({}).build();
 * //                       ^ Error: 'this' is not assignable to
 * //                         'A2AServerBuilder<true, true>'.
 *
 * new A2AServerBuilder({})
 *   .withAgentCard(card)
 *   .withStreamingTaskHandler(handler)
 *   .build(); // OK
 * ```
 *
 * The runtime `build()` still throws {@link A2AServerBuilderError} when invoked
 * via paths that escape the compile-time check (e.g., dynamically typed
 * callers).
 *
 * Mirrors the Go ADK's `A2AServerBuilder`
 * (https://github.com/inference-gateway/adk/blob/main/server/server_builder.go).
 */
export class A2AServerBuilder<
  HasCard extends boolean = false,
  HasHandler extends boolean = false,
> {
  // Phantom field — declare-only so it doesn't exist at runtime. Forces the
  // generic parameters to participate in structural compatibility checks,
  // without which `A2AServerBuilder<false, false>` and
  // `A2AServerBuilder<true, true>` collapse into the same type and the
  // `this:` constraint on `build()` becomes a no-op.
  declare private readonly __builderState: {
    readonly hasCard: HasCard;
    readonly hasHandler: HasHandler;
  };
  private readonly builderConfig: A2AServerBuilderConfig;
  private builderLogger: Logger;
  private agentCard: AgentCard | undefined;
  private backgroundTaskHandler: BackgroundTaskHandler | undefined;
  private streamingTaskHandler: StreamingTaskHandler | undefined;
  private taskHandler: TaskHandler | undefined;
  private streamableTaskHandler: StreamableTaskHandler | undefined;
  private taskResultProcessor: TaskResultProcessor | undefined;
  private agent: OpenAICompatibleAgent | undefined;
  private artifactService: ArtifactService | undefined;

  constructor(
    config: A2AServerBuilderConfig = {},
    logger: Logger = NOOP_LOGGER
  ) {
    this.builderConfig = config;
    this.builderLogger = logger;
  }

  /** Set a custom background task handler. */
  withBackgroundTaskHandler(
    handler: BackgroundTaskHandler
  ): A2AServerBuilder<HasCard, true> {
    this.backgroundTaskHandler = handler;
    return this as unknown as A2AServerBuilder<HasCard, true>;
  }

  /** Set a custom streaming task handler. */
  withStreamingTaskHandler(
    handler: StreamingTaskHandler
  ): A2AServerBuilder<HasCard, true> {
    this.streamingTaskHandler = handler;
    return this as unknown as A2AServerBuilder<HasCard, true>;
  }

  /**
   * Set a custom interface-based background {@link TaskHandler}. The builder
   * adapts it to the lower-level {@link BackgroundTaskHandler} function and
   * forwards the {@link TaskHandlerContext.signal} on every invocation. If an
   * agent has already been registered via {@link withAgent}, it is injected
   * into the handler via `setAgent` at registration time; an agent registered
   * later will overwrite the binding.
   *
   * Mirrors the Go ADK's `WithTaskHandler` builder method.
   */
  withTaskHandler(handler: TaskHandler): A2AServerBuilder<HasCard, true> {
    if (this.agent !== undefined) {
      handler.setAgent(this.agent);
    }
    this.taskHandler = handler;
    this.backgroundTaskHandler = (context) =>
      handler.handleTask(
        { signal: context.signal } satisfies TaskHandlerContext,
        context.task,
        context.message
      );
    return this as unknown as A2AServerBuilder<HasCard, true>;
  }

  /**
   * Set a custom interface-based {@link StreamableTaskHandler}. The builder
   * adapts it to the lower-level {@link StreamingTaskHandler} function by
   * forwarding each yielded CloudEvent verbatim to the SSE response (wrapped
   * in a `rawCloudEvent` {@link StreamingTaskEvent} the message-stream
   * pipeline knows how to emit). If an agent has already been registered via
   * {@link withAgent}, it is injected into the handler via `setAgent` at
   * registration time.
   *
   * Mirrors the Go ADK's `WithStreamableTaskHandler` builder method.
   */
  withStreamableTaskHandler(
    handler: StreamableTaskHandler
  ): A2AServerBuilder<HasCard, true> {
    if (this.agent !== undefined) {
      handler.setAgent(this.agent);
    }
    this.streamableTaskHandler = handler;
    this.streamingTaskHandler = async function* (context) {
      const taskCtx: TaskHandlerContext = { signal: context.signal };
      for await (const event of handler.handleStreamingTask(
        taskCtx,
        context.task,
        context.message
      )) {
        yield { type: 'rawCloudEvent', event } satisfies StreamingTaskEvent;
      }
    };
    return this as unknown as A2AServerBuilder<HasCard, true>;
  }

  /**
   * Install a default background task handler that walks a freshly-created
   * task through `IN_PROGRESS -> COMPLETED`. Useful as a stub during early
   * bootstrap; replace once a real agent integration is wired.
   */
  withDefaultBackgroundTaskHandler(): A2AServerBuilder<HasCard, true> {
    this.backgroundTaskHandler = createDefaultBackgroundTaskHandler();
    return this as unknown as A2AServerBuilder<HasCard, true>;
  }

  /**
   * Install a default streaming task handler that emits a single
   * `statusChanged(COMPLETED)` event. Stub for early bootstrap - see
   * {@link withDefaultBackgroundTaskHandler}.
   */
  withDefaultStreamingTaskHandler(): A2AServerBuilder<HasCard, true> {
    this.streamingTaskHandler = createDefaultStreamingTaskHandler();
    return this as unknown as A2AServerBuilder<HasCard, true>;
  }

  /** Install both default handlers. See the individual `withDefault*` methods. */
  withDefaultTaskHandlers(): A2AServerBuilder<HasCard, true> {
    this.backgroundTaskHandler = createDefaultBackgroundTaskHandler();
    this.streamingTaskHandler = createDefaultStreamingTaskHandler();
    return this as unknown as A2AServerBuilder<HasCard, true>;
  }

  withTaskResultProcessor(processor: TaskResultProcessor): this {
    this.taskResultProcessor = processor;
    return this;
  }

  withAgent(agent: OpenAICompatibleAgent): this {
    this.agent = agent;
    if (this.taskHandler !== undefined) {
      this.taskHandler.setAgent(agent);
    }
    if (this.streamableTaskHandler !== undefined) {
      this.streamableTaskHandler.setAgent(agent);
    }
    return this;
  }

  withAgentCard(card: AgentCard): A2AServerBuilder<true, HasHandler> {
    this.agentCard = card;
    return this as unknown as A2AServerBuilder<true, HasHandler>;
  }

  /**
   * Load an agent card from disk and store it. Reuses
   * {@link loadAgentCardFromFile}, so `${VAR}` placeholders are resolved
   * against `process.env` and a missing variable surfaces as
   * {@link AgentCardLoadError}.
   */
  withAgentCardFromFile(
    filePath: string,
    overrides?: Partial<AgentCard>
  ): A2AServerBuilder<true, HasHandler> {
    this.agentCard = loadAgentCardFromFile(
      filePath,
      overrides !== undefined ? { overrides } : {}
    );
    return this as unknown as A2AServerBuilder<true, HasHandler>;
  }

  withLogger(logger: Logger): this {
    this.builderLogger = logger;
    return this;
  }

  withArtifactService(service: ArtifactService): this {
    this.artifactService = service;
    return this;
  }

  /**
   * Create and return the configured A2A server.
   *
   * Validates that:
   *  - An agent card has been supplied.
   *  - At least one task handler is configured.
   *  - If the agent card advertises `capabilities.streaming: true`, a
   *    streaming task handler is configured.
   *  - If the agent card does not advertise streaming, a background task
   *    handler is configured.
   *
   * Throws {@link A2AServerBuilderError} on any validation failure.
   */
  build(this: A2AServerBuilder<true, true>): A2AServer {
    return (this as unknown as A2AServerBuilder).buildInternal();
  }

  /**
   * Read accessors used by tests and by future server-internal wiring (e.g.,
   * a background worker that needs the configured handler). Not part of the
   * stable public surface.
   */
  getBackgroundTaskHandler(): BackgroundTaskHandler | undefined {
    return this.backgroundTaskHandler;
  }
  getStreamingTaskHandler(): StreamingTaskHandler | undefined {
    return this.streamingTaskHandler;
  }
  getTaskHandler(): TaskHandler | undefined {
    return this.taskHandler;
  }
  getStreamableTaskHandler(): StreamableTaskHandler | undefined {
    return this.streamableTaskHandler;
  }
  getTaskResultProcessor(): TaskResultProcessor | undefined {
    return this.taskResultProcessor;
  }
  getAgent(): OpenAICompatibleAgent | undefined {
    return this.agent;
  }
  getAgentCard(): AgentCard | undefined {
    return this.agentCard;
  }
  getArtifactService(): ArtifactService | undefined {
    return this.artifactService;
  }
  getLogger(): Logger {
    return this.builderLogger;
  }

  private buildInternal(): A2AServer {
    const card = this.agentCard;
    if (card === undefined) {
      throw new A2AServerBuilderError(
        'agent card must be configured before build() - use withAgentCard() or withAgentCardFromFile()'
      );
    }
    if (
      this.backgroundTaskHandler === undefined &&
      this.streamingTaskHandler === undefined
    ) {
      throw new A2AServerBuilderError(
        'at least one task handler must be configured - use withBackgroundTaskHandler(), withStreamingTaskHandler(), or withDefaultTaskHandlers()'
      );
    }

    const streamingEnabled = card.capabilities.streaming === true;
    if (streamingEnabled && this.streamingTaskHandler === undefined) {
      throw new A2AServerBuilderError(
        'agent card advertises streaming capability but no streaming handler is configured - use withStreamingTaskHandler() or withDefaultStreamingTaskHandler()'
      );
    }
    if (!streamingEnabled && this.backgroundTaskHandler === undefined) {
      throw new A2AServerBuilderError(
        'agent card does not advertise streaming capability but no background handler is configured - use withBackgroundTaskHandler() or withDefaultBackgroundTaskHandler()'
      );
    }

    const storage = this.builderConfig.storage ?? new InMemoryTaskStorage();
    const cancellationRegistry = new TaskCancellationRegistry();
    const eventBusRegistry = new TaskEventBusRegistry();

    const serverConfig: A2AServerConfig = {
      card,
      ...(this.builderConfig.cacheControl !== undefined
        ? { cacheControl: this.builderConfig.cacheControl }
        : {}),
      ...(this.builderConfig.jsonRpcPath !== undefined
        ? { jsonRpcPath: this.builderConfig.jsonRpcPath }
        : {}),
    };

    const server = new A2AServer(serverConfig);

    if (this.backgroundTaskHandler !== undefined) {
      server.registerMethod(
        MESSAGE_SEND_METHOD,
        createMessageSendHandler({ storage })
      );
    }

    if (this.streamingTaskHandler !== undefined) {
      server.registerStreamingMethod(
        MESSAGE_STREAM_METHOD,
        createMessageStreamHandler({
          storage,
          executor: this.streamingTaskHandler,
          cancellationRegistry,
          eventBusRegistry,
        })
      );
      server.registerStreamingMethod(
        TASK_RESUBSCRIBE_METHOD,
        createTaskResubscribeHandler({
          storage,
          eventBusRegistry,
        })
      );
    }

    server.registerMethod(
      TASK_CANCEL_METHOD,
      createTaskCancelHandler({
        storage,
        registry: cancellationRegistry,
      })
    );

    return server;
  }
}

function createDefaultBackgroundTaskHandler(): BackgroundTaskHandler {
  return ({ task }) => {
    if (isTerminal(task.state)) {
      return task;
    }
    let next = task;
    if (next.state === TASK_STATE.PENDING) {
      next = transitionTask(next, TASK_STATE.IN_PROGRESS);
    }
    return transitionTask(next, TASK_STATE.COMPLETED);
  };
}

function createDefaultStreamingTaskHandler(): StreamingTaskHandler {
  return async function* (
    context: StreamingExecutorContext
  ): AsyncIterable<StreamingTaskEvent> {
    void context;
    yield {
      type: 'statusChanged',
      state: TASK_STATE.COMPLETED,
    };
  };
}
