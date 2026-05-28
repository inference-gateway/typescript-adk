import {
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Span,
} from '@opentelemetry/api';

/**
 * Span name for the A2A JSON-RPC request lifecycle. The server creates one of
 * these per HTTP POST to the JSON-RPC endpoint, with the JSON-RPC method
 * recorded as a span attribute.
 */
export const SPAN_NAME_JSONRPC_REQUEST = 'adk.jsonrpc.request';

/**
 * Span name for a background task lifecycle. Created when a task is dispatched
 * to a {@link import('../server/server-builder.js').BackgroundTaskHandler} and
 * ended when the handler returns or throws.
 */
export const SPAN_NAME_BACKGROUND_TASK = 'adk.task.background';

/** Span name for a streaming task lifecycle. */
export const SPAN_NAME_STREAMING_TASK = 'adk.task.streaming';

/** Span name for a single LLM chat completion call. */
export const SPAN_NAME_LLM_COMPLETION = 'adk.llm.completion';

/**
 * Span attribute holding the JSON-RPC method name (e.g. `message/send`).
 * Mirrors the Go ADK's `adk.jsonrpc.method`.
 */
export const ATTR_JSONRPC_METHOD = 'adk.jsonrpc.method';

/**
 * Span attribute holding the JSON-RPC request id. Set as a string regardless
 * of whether the inbound id was numeric, because OTel attribute values are
 * stringly typed in most backends.
 */
export const ATTR_JSONRPC_REQUEST_ID = 'adk.jsonrpc.request_id';

/** Span attribute holding the A2A task id. */
export const ATTR_TASK_ID = 'adk.task.id';

/** Span attribute holding the A2A context id. */
export const ATTR_CONTEXT_ID = 'adk.context.id';

/**
 * Default span kind for the JSON-RPC request span - a server-side span sitting
 * at the inbound HTTP boundary.
 */
export const DEFAULT_JSONRPC_SPAN_KIND = SpanKind.SERVER;

/**
 * Default span kind for background/streaming task spans. INTERNAL is
 * appropriate because the work happens within the same process; the inbound
 * HTTP boundary already gets a SERVER span via auto-instrumentation.
 */
export const DEFAULT_TASK_SPAN_KIND = SpanKind.INTERNAL;

/**
 * Default span kind for an outbound LLM call - CLIENT, matching the OTel
 * convention for any RPC the service initiates.
 */
export const DEFAULT_LLM_SPAN_KIND = SpanKind.CLIENT;

/**
 * Mark `span` as failed with `error` recorded as an exception. Safe to call on
 * a no-op span - the global tracer's noop span implements `recordException`
 * and `setStatus` as no-ops.
 */
export function recordSpanError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    return;
  }
  span.recordException({ name: 'Error', message: String(error) });
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
}

/**
 * Attach `attributes` to `span` while dropping `undefined` values. The OTel
 * API rejects `undefined` attribute values, so call sites would have to filter
 * conditionally otherwise.
 */
export function setSpanAttributes(
  span: Span,
  attributes: Readonly<Record<string, string | number | boolean | undefined>>
): void {
  const filtered: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    filtered[key] = value;
  }
  span.setAttributes(filtered);
}
