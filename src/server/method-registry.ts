import {
  USAGE_EXTENSION_URI,
  withoutExtension,
} from '../agent/usage-extension.js';
import type { Struct } from '../types/generated/a2a.js';
import type { JSONRPCId } from './jsonrpc.js';

/**
 * Context passed to every JSON-RPC method handler.
 *
 * `signal` aborts when the originating HTTP request is cancelled by the
 * client or when the server is shutting down. Long-running handlers should
 * propagate it to downstream calls so cancellation actually unwinds.
 * `requestId` is the JSON-RPC `id` of the request being handled.
 * `activatedExtensions` holds the extension URIs the request activated through
 * the `A2A-Extensions` header. Absent means none.
 */
export interface MethodContext {
  readonly signal: AbortSignal;
  readonly requestId?: JSONRPCId;
  readonly activatedExtensions?: ReadonlySet<string>;
}

/**
 * The task or status update as the client may see it: without the usage
 * extension's metadata unless the request activated it, since extensions are
 * inactive by default.
 */
export function withoutInactiveExtensions<
  T extends { readonly metadata?: Struct },
>(value: T, context: MethodContext): T {
  return context.activatedExtensions?.has(USAGE_EXTENSION_URI) === true
    ? value
    : withoutExtension(value, USAGE_EXTENSION_URI);
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
