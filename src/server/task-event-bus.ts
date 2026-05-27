import { AGENT_EVENT_TYPE, type CloudEvent } from './cloudevents.js';

/**
 * Listener invoked once per event the bus publishes after subscription. Errors
 * thrown by the listener are caught and dropped - one slow/broken subscriber
 * cannot stall the producer or the other listeners.
 */
export type TaskEventListener = (event: CloudEvent) => void;

/**
 * Listener invoked exactly once when the bus closes. Used by subscribers to
 * close their downstream SSE writer.
 */
export type TaskEventCloseListener = () => void;

/**
 * Handle returned by {@link TaskEventBus.subscribe}. `lastStatus` is the most
 * recent `adk.agent.task.status.changed` event the bus has observed (if any);
 * subscribers replay it as the first SSE frame so a late `tasks/resubscribe`
 * client immediately sees the current task state. `unsubscribe` is idempotent;
 * call it from a `finally` block to detach the listener.
 */
export interface TaskEventSubscription {
  readonly lastStatus: CloudEvent | undefined;
  unsubscribe(): void;
}

/**
 * Per-task pub/sub primitive used by `message/stream` and `tasks/resubscribe`
 * to fan out CloudEvents to one or more SSE subscribers.
 *
 * The producing side calls {@link publish} once per emitted event; every
 * subscribed listener is invoked synchronously in subscription order. A copy
 * of the most recent `task.status.changed` event is retained as the replay
 * buffer so a subscriber that joins after the task has already transitioned
 * out of `PENDING` still sees the current state as the first frame on its
 * stream.
 *
 * Lifecycle:
 *  - Open: listeners receive every `publish`.
 *  - Closed (via {@link close}): every registered listener's `onClose` is
 *    invoked exactly once, listeners are dropped, and subsequent `publish` /
 *    `subscribe` calls are no-ops (subscribers receive a closed handle whose
 *    `lastStatus` still reflects the bus's final replay buffer).
 *
 * Mirrors the per-task subscription registries the Go ADK keeps in
 * `server/protocol.go` for its resubscribe flow.
 */
export class TaskEventBus {
  private readonly listeners = new Set<{
    readonly onEvent: TaskEventListener;
    readonly onClose: TaskEventCloseListener;
  }>();
  private bufferedStatus: CloudEvent | undefined = undefined;
  private isClosed = false;

  /** True after {@link close} has been called. */
  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * The most recent `adk.agent.task.status.changed` event observed by the bus,
   * or `undefined` if none has been published yet. Exposed so resubscribers
   * that bypass {@link subscribe} (e.g., when the task is already terminal in
   * storage) can still replay the last state.
   */
  get lastStatus(): CloudEvent | undefined {
    return this.bufferedStatus;
  }

  /** Number of currently subscribed listeners. Useful for diagnostics. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Publish `event` to every subscribed listener. If `event` is a
   * `task.status.changed` CloudEvent, it is also stored as the new replay
   * buffer so future subscribers see it. No-op after {@link close}.
   */
  publish(event: CloudEvent): void {
    if (this.isClosed) {
      return;
    }
    if (event.type === AGENT_EVENT_TYPE.TASK_STATUS_CHANGED) {
      this.bufferedStatus = event;
    }
    for (const listener of this.listeners) {
      try {
        listener.onEvent(event);
      } catch {
        // Listener faulted; drop it from the fan-out without disturbing the
        // producer or the remaining listeners. The downstream SSE writer is
        // expected to close itself shortly afterwards.
      }
    }
  }

  /**
   * Attach `onEvent` (called once per subsequent {@link publish}) and `onClose`
   * (called once when the bus closes). Returns a {@link TaskEventSubscription}
   * carrying the current replay buffer plus an `unsubscribe()` to detach.
   *
   * Subscribing after {@link close} immediately invokes `onClose` and returns
   * a handle with no live subscription; `lastStatus` still carries the final
   * buffered status so late subscribers can replay it before closing their
   * own stream.
   */
  subscribe(
    onEvent: TaskEventListener,
    onClose: TaskEventCloseListener
  ): TaskEventSubscription {
    if (this.isClosed) {
      try {
        onClose();
      } catch {
        // ignored - same rationale as publish
      }
      return {
        lastStatus: this.bufferedStatus,
        unsubscribe: () => {
          // no-op
        },
      };
    }
    const listener = { onEvent, onClose };
    this.listeners.add(listener);
    return {
      lastStatus: this.bufferedStatus,
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Close the bus. Notifies every subscriber via their `onClose` listener,
   * drops the listener set, and marks the bus closed so subsequent publishes
   * are ignored. Idempotent.
   */
  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    const snapshot = [...this.listeners];
    this.listeners.clear();
    for (const listener of snapshot) {
      try {
        listener.onClose();
      } catch {
        // ignored
      }
    }
  }
}

/**
 * Process-wide registry of per-task event buses. The `message/stream` handler
 * creates a bus on task start and removes it when the task terminates; the
 * `tasks/resubscribe` handler looks up the bus by task id to attach an SSE
 * subscriber.
 *
 * Mirrors the role of the Go ADK's per-task subscription map in
 * `server/protocol.go`. Single-threaded by virtue of JavaScript's execution
 * model: registry mutation is atomic between awaits, so no internal locking
 * is needed.
 */
export class TaskEventBusRegistry {
  private readonly buses = new Map<string, TaskEventBus>();

  /**
   * Return the existing bus for `taskId`, creating one if none is registered.
   * The producing side calls this once on task start so the same instance is
   * shared with future {@link get} lookups by resubscribers.
   */
  getOrCreate(taskId: string): TaskEventBus {
    let bus = this.buses.get(taskId);
    if (bus === undefined) {
      bus = new TaskEventBus();
      this.buses.set(taskId, bus);
    }
    return bus;
  }

  /**
   * Look up the bus registered for `taskId`. Returns `undefined` if none is
   * registered (either because no producer ever started one, or because it
   * has already been removed via {@link delete}).
   */
  get(taskId: string): TaskEventBus | undefined {
    return this.buses.get(taskId);
  }

  /**
   * Remove the bus registered for `taskId` from the registry. Does not call
   * {@link TaskEventBus.close} on it - the caller is expected to close the
   * bus separately so subscribers see the close signal. Returns `true` if a
   * bus was registered (and is now gone), `false` otherwise.
   */
  delete(taskId: string): boolean {
    return this.buses.delete(taskId);
  }

  /** True when a bus is registered for `taskId`. */
  has(taskId: string): boolean {
    return this.buses.has(taskId);
  }

  /** Number of currently registered buses. */
  size(): number {
    return this.buses.size;
  }

  /**
   * Drop every bus from the registry without closing it. Intended for tests
   * that share a registry across cases. Does not invoke `close()` on the
   * buses - production code should rely on the per-task lifecycle so
   * subscribers receive their close signal before the bus is dropped.
   */
  clear(): void {
    this.buses.clear();
  }
}
