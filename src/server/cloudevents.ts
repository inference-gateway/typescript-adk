/**
 * CloudEvents v1.0 (JSON structured mode) envelope helpers used by the SSE
 * streaming transport. See https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md.
 *
 * The envelope is hand-rolled rather than pulling in the `cloudevents` npm
 * package - the spec surface we need (id, source, type, time, datacontenttype,
 * subject, data, plus extensions) is small enough that the dependency was not
 * worth the install footprint.
 */

/** Required value of the CloudEvents `specversion` attribute for v1.0. */
export const CLOUDEVENTS_SPEC_VERSION = '1.0' as const;

/**
 * Media type for a CloudEvents v1.0 JSON structured-mode envelope. Useful when
 * serving a single envelope outside of an SSE stream (the SSE stream itself
 * uses `text/event-stream` and embeds JSON envelopes inside `data:` frames).
 */
export const CLOUDEVENTS_CONTENT_TYPE = 'application/cloudevents+json';

/**
 * Default value of the CloudEvents `source` attribute. Matches the literal
 * string emitted by the Go ADK (`server/agent_streamable.go`) so that
 * cross-language consumers can dedupe / route on a single value.
 *
 * The CE spec recommends an absolute URI for `source`; we follow the Go ADK
 * convention of a short relative URI-reference instead, which is also valid
 * per the spec.
 */
export const DEFAULT_AGENT_EVENT_SOURCE = 'adk/agent';

/**
 * Default value of the CloudEvents `datacontenttype` attribute. Required to
 * be a JSON media type for the data to be serialised as a direct JSON value
 * (rather than as a stringified payload) in structured mode.
 */
export const DEFAULT_CLOUDEVENTS_DATA_CONTENT_TYPE = 'application/json';

/**
 * Canonical event-type constants for the streaming transport. Identical to
 * the Go ADK's `Event*` constants in `types/types.go` so a TS publisher and a
 * Go consumer (or vice versa) can interoperate without translation.
 */
export const AGENT_EVENT_TYPE = {
  DELTA: 'adk.agent.delta',
  ITERATION_COMPLETED: 'adk.agent.iteration.completed',
  TOOL_STARTED: 'adk.agent.tool.started',
  TOOL_COMPLETED: 'adk.agent.tool.completed',
  TOOL_FAILED: 'adk.agent.tool.failed',
  TOOL_RESULT: 'adk.agent.tool.result',
  INPUT_REQUIRED: 'adk.agent.input.required',
  TASK_STATUS_CHANGED: 'adk.agent.task.status.changed',
  TASK_INTERRUPTED: 'adk.agent.task.interrupted',
  STREAM_FAILED: 'adk.agent.stream.failed',
} as const;

export type AgentEventType =
  (typeof AGENT_EVENT_TYPE)[keyof typeof AGENT_EVENT_TYPE];

/**
 * Payload of an {@link AGENT_EVENT_TYPE.ITERATION_COMPLETED} CloudEvent. Emitted
 * once per LLM iteration by the default streaming handler; mirrors the Go ADK
 * `NewIterationCompletedEvent` in `types/types.go`.
 */
export interface AgentIterationCompletedEventData {
  readonly iteration: number;
  readonly taskId: string;
  readonly contextId: string;
  readonly message?: import('../types/generated/a2a.js').Message;
}

/**
 * Payload of {@link AGENT_EVENT_TYPE.TOOL_STARTED} /
 * {@link AGENT_EVENT_TYPE.TOOL_COMPLETED} CloudEvents. Mirrors the Go ADK's
 * tool lifecycle events.
 */
export interface AgentToolEventData {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly taskId: string;
  readonly contextId: string;
  /** Raw JSON arguments string supplied by the model. Set on `tool.started`. */
  readonly arguments?: string;
}

/**
 * Payload of an {@link AGENT_EVENT_TYPE.TOOL_FAILED} CloudEvent.
 */
export interface AgentToolFailedEventData extends AgentToolEventData {
  readonly error: string;
}

/**
 * Payload of an {@link AGENT_EVENT_TYPE.TOOL_RESULT} CloudEvent. Carries the
 * string returned by the toolbox after a successful or failed execution; the
 * `isError` flag distinguishes the two.
 */
export interface AgentToolResultEventData extends AgentToolEventData {
  readonly result: string;
  readonly isError: boolean;
}

/** JSON-representable value for a CloudEvents extension attribute. */
export type CloudEventExtensionValue = string | number | boolean;

/**
 * A CloudEvents v1.0 JSON structured-mode envelope.
 *
 * The declared shape covers the attributes we set explicitly; extensions are
 * additional top-level string-keyed properties added at runtime by
 * {@link createCloudEvent} and are not modelled in the interface.
 */
export interface CloudEvent<T = unknown> {
  readonly specversion: typeof CLOUDEVENTS_SPEC_VERSION;
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly time?: string;
  readonly datacontenttype?: string;
  readonly subject?: string;
  readonly data?: T;
}

export interface CreateCloudEventInput<T> {
  /**
   * Event id. Defaults to `crypto.randomUUID()`. Per the CE spec, the
   * `source + id` pair MUST be unique within the producer.
   */
  readonly id?: string;
  /** CE `source`. Defaults to {@link DEFAULT_AGENT_EVENT_SOURCE}. */
  readonly source?: string;
  /** CE `type`. Required. Typically one of {@link AGENT_EVENT_TYPE}. */
  readonly type: string;
  /** Payload. Serialised verbatim as the CE `data` member. */
  readonly data: T;
  /**
   * CE `time`. Accepts a `Date` (converted to ISO 8601) or a pre-formatted
   * RFC 3339 string. Defaults to `new Date().toISOString()`.
   */
  readonly time?: Date | string;
  /** CE `subject`. */
  readonly subject?: string;
  /** CE `datacontenttype`. Defaults to {@link DEFAULT_CLOUDEVENTS_DATA_CONTENT_TYPE}. */
  readonly datacontenttype?: string;
  /**
   * Extension attributes, serialised as top-level members of the envelope.
   * Reserved CE attribute names (`specversion`, `id`, `source`, `type`, `time`,
   * `datacontenttype`, `dataschema`, `subject`, `data`, `data_base64`) are
   * rejected to avoid envelope corruption.
   */
  readonly extensions?: Readonly<Record<string, CloudEventExtensionValue>>;
}

const RESERVED_CE_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  'specversion',
  'id',
  'source',
  'type',
  'time',
  'datacontenttype',
  'dataschema',
  'subject',
  'data',
  'data_base64',
]);

/**
 * Build a CloudEvents v1.0 envelope. Throws `TypeError` for empty `type` /
 * `id` / `source` and for extension names that collide with reserved CE
 * attributes.
 *
 * Returns a plain object whose own enumerable properties include the
 * declared CE attributes plus any supplied extensions, in insertion order:
 * `specversion`, `id`, `source`, `type`, `time`, `datacontenttype`, `subject?`,
 * `data`, then extensions. JSON-stringifying the result yields the wire-format
 * envelope.
 */
export function createCloudEvent<T>(
  input: CreateCloudEventInput<T>
): CloudEvent<T> {
  if (typeof input.type !== 'string' || input.type.length === 0) {
    throw new TypeError('CloudEvent.type must be a non-empty string');
  }

  const id = input.id ?? crypto.randomUUID();
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('CloudEvent.id must be a non-empty string');
  }

  const source = input.source ?? DEFAULT_AGENT_EVENT_SOURCE;
  if (typeof source !== 'string' || source.length === 0) {
    throw new TypeError('CloudEvent.source must be a non-empty string');
  }

  const time =
    input.time instanceof Date
      ? input.time.toISOString()
      : (input.time ?? new Date().toISOString());

  const datacontenttype =
    input.datacontenttype ?? DEFAULT_CLOUDEVENTS_DATA_CONTENT_TYPE;

  const envelope: Record<string, unknown> = {
    specversion: CLOUDEVENTS_SPEC_VERSION,
    id,
    source,
    type: input.type,
    time,
    datacontenttype,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    data: input.data,
  };

  if (input.extensions !== undefined) {
    for (const [name, value] of Object.entries(input.extensions)) {
      if (RESERVED_CE_ATTRIBUTE_NAMES.has(name)) {
        throw new TypeError(
          `CloudEvent extension "${name}" collides with a reserved CE attribute name`
        );
      }
      envelope[name] = value;
    }
  }

  return envelope as unknown as CloudEvent<T>;
}
