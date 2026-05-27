import type { ManagedTask } from '../agent/task.js';
import type { Message } from '../types/generated/a2a.js';
import type { CloudEvent } from './cloudevents.js';
import type { OpenAICompatibleAgent } from './server-builder.js';

/**
 * Context handed to {@link TaskHandler} and {@link StreamableTaskHandler}
 * implementations on every invocation.
 *
 * The Go ADK uses `context.Context` to carry cancellation and request-scoped
 * values; in TypeScript the equivalent is an {@link AbortSignal}. Long-running
 * downstream work (LLM completions, tool dispatches, fetches) should propagate
 * `signal` so cancellation actually unwinds.
 */
export interface TaskHandlerContext {
  /**
   * Aborts when the originating request is cancelled - either by the client
   * (HTTP disconnect, deadline) or by the server tearing down for any reason.
   * Handlers should observe it cooperatively: bail out promptly once it fires
   * and avoid emitting further events / state transitions.
   */
  readonly signal: AbortSignal;
}

/**
 * Domain-specific background task handler.
 *
 * Mirrors the Go ADK's `TaskHandler` interface in `server/task_handler.go` -
 * implementations process a task end-to-end and return the updated (typically
 * terminal-state) task. Wire into the server via
 * {@link import('./server-builder.js').A2AServerBuilder.withTaskHandler}; the
 * builder adapts the interface to the lower-level
 * {@link import('./server-builder.js').BackgroundTaskHandler} function that
 * the worker pipeline consumes.
 *
 * Concrete implementations usually extend {@link BaseTaskHandler} for free
 * agent accessors.
 */
export interface TaskHandler {
  /**
   * Process a task end-to-end. Implementations should return the updated task
   * (typically in a terminal state - `COMPLETED` / `FAILED` / `CANCELLED` /
   * `INPUT_REQUIRED`). Honour {@link TaskHandlerContext.signal} by aborting
   * downstream work and returning a `CANCELLED` task when the signal fires.
   */
  handleTask(
    context: TaskHandlerContext,
    task: ManagedTask,
    message: Message
  ): Promise<ManagedTask>;
  /**
   * Inject the configured agent. Called by the builder on registration so the
   * handler can drive an agent during {@link handleTask}.
   */
  setAgent(agent: OpenAICompatibleAgent): void;
  /** Return the currently injected agent, or `undefined` if none was set. */
  getAgent(): OpenAICompatibleAgent | undefined;
}

/**
 * Domain-specific streaming task handler.
 *
 * Mirrors the Go ADK's `StreamableTaskHandler` interface in
 * `server/task_handler.go` - implementations yield CloudEvents as the task
 * progresses; the framework forwards each event to the SSE response verbatim
 * and handles the lifecycle bookends (initial
 * `task.status.changed -> IN_PROGRESS` event before the handler runs, terminal
 * status event on completion / cancellation / failure after the handler
 * returns).
 *
 * Wire into the server via
 * {@link import('./server-builder.js').A2AServerBuilder.withStreamableTaskHandler};
 * the builder adapts the interface to the lower-level
 * {@link import('./server-builder.js').StreamingTaskHandler} function.
 *
 * Concrete implementations usually extend {@link BaseStreamableTaskHandler}
 * for free agent accessors.
 */
export interface StreamableTaskHandler {
  /**
   * Process a task and yield CloudEvents. Construct each envelope with
   * {@link import('./cloudevents.js').createCloudEvent}. Honour
   * {@link TaskHandlerContext.signal} by returning from the iterable promptly
   * once it fires - the framework will transition the task to `CANCELLED`
   * and emit a final status event itself.
   */
  handleStreamingTask(
    context: TaskHandlerContext,
    task: ManagedTask,
    message: Message
  ): AsyncIterable<CloudEvent>;
  /**
   * Inject the configured agent. Called by the builder on registration so the
   * handler can drive an agent during {@link handleStreamingTask}.
   */
  setAgent(agent: OpenAICompatibleAgent): void;
  /** Return the currently injected agent, or `undefined` if none was set. */
  getAgent(): OpenAICompatibleAgent | undefined;
}

/**
 * Convenience base class for {@link TaskHandler} implementations. Provides
 * agent storage so concrete subclasses only need to implement
 * {@link handleTask}.
 *
 * ```ts
 * class EchoTaskHandler extends BaseTaskHandler {
 *   async handleTask(ctx, task, message) {
 *     // ...do work, return updated task
 *   }
 * }
 * ```
 */
export abstract class BaseTaskHandler implements TaskHandler {
  private agent: OpenAICompatibleAgent | undefined;

  abstract handleTask(
    context: TaskHandlerContext,
    task: ManagedTask,
    message: Message
  ): Promise<ManagedTask>;

  setAgent(agent: OpenAICompatibleAgent): void {
    this.agent = agent;
  }

  getAgent(): OpenAICompatibleAgent | undefined {
    return this.agent;
  }
}

/**
 * Convenience base class for {@link StreamableTaskHandler} implementations.
 * Same shape as {@link BaseTaskHandler}; provides agent storage so concrete
 * subclasses only need to implement {@link handleStreamingTask}.
 */
export abstract class BaseStreamableTaskHandler implements StreamableTaskHandler {
  private agent: OpenAICompatibleAgent | undefined;

  abstract handleStreamingTask(
    context: TaskHandlerContext,
    task: ManagedTask,
    message: Message
  ): AsyncIterable<CloudEvent>;

  setAgent(agent: OpenAICompatibleAgent): void {
    this.agent = agent;
  }

  getAgent(): OpenAICompatibleAgent | undefined {
    return this.agent;
  }
}
