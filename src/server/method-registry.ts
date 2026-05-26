/**
 * Context passed to every JSON-RPC method handler.
 *
 * `signal` aborts when the originating HTTP request is cancelled by the
 * client or when the server is shutting down. Long-running handlers should
 * propagate it to downstream calls so cancellation actually unwinds.
 */
export interface MethodContext {
  readonly signal: AbortSignal;
}

/**
 * A JSON-RPC method handler. Receives the raw `params` value from the request
 * (already validated as `undefined`, `null`, an object, or an array) and the
 * call context. Return value becomes the JSON-RPC `result`.
 *
 * Throw {@link JSONRPCError} to surface a structured error code to the caller;
 * any other thrown error is mapped to `-32603 internal error` to avoid leaking
 * internals.
 */
export type MethodHandler<P = unknown, R = unknown> = (
  params: P,
  context: MethodContext
) => Promise<R> | R;

/**
 * Mutable registry of JSON-RPC method handlers. Methods can be registered or
 * removed at any time - lookups during dispatch reflect the current state.
 */
export class MethodRegistry {
  private readonly methods = new Map<string, MethodHandler>();

  register<P = unknown, R = unknown>(
    name: string,
    handler: MethodHandler<P, R>
  ): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('method name must be a non-empty string');
    }
    this.methods.set(name, handler as MethodHandler);
  }

  unregister(name: string): boolean {
    return this.methods.delete(name);
  }

  has(name: string): boolean {
    return this.methods.has(name);
  }

  get(name: string): MethodHandler | undefined {
    return this.methods.get(name);
  }

  list(): string[] {
    return [...this.methods.keys()];
  }

  clear(): void {
    this.methods.clear();
  }
}
