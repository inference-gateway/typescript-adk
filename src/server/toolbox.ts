import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { ManagedTask } from '../agent/task.js';
import type { Struct } from '../types/generated/a2a.js';
import { NOOP_LOGGER, type Logger } from './server-builder.js';

/**
 * Reserved tool name the handler intercepts to pause a task awaiting user
 * input. When the LLM calls a tool with this name, the handler transitions the
 * task to `INPUT_REQUIRED` rather than executing it via the toolbox.
 *
 * Mirrors the Go ADK's `input_required` reserved tool (see `adk/server/`).
 */
export const INPUT_REQUIRED_TOOL = 'input_required' as const;

/**
 * Reserved tool name the handler intercepts to surface an artifact attached to
 * the task. Only advertised to the LLM when {@link DefaultToolBoxOptions.enableCreateArtifact}
 * is set, since downstream pipelines without an artifact service have no way
 * to act on the call.
 */
export const CREATE_ARTIFACT_TOOL = 'create_artifact' as const;

/**
 * Names the framework owns and refuses to let user tools shadow. Currently
 * includes {@link INPUT_REQUIRED_TOOL} and {@link CREATE_ARTIFACT_TOOL}; both
 * names are reserved regardless of whether the corresponding reserved tool is
 * actually pre-registered (a user opt-out of `create_artifact` still cannot
 * register their own tool under that name).
 */
export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  INPUT_REQUIRED_TOOL,
  CREATE_ARTIFACT_TOOL,
]);

/**
 * Description advertised to the LLM for the reserved {@link INPUT_REQUIRED_TOOL}.
 * Mirrors the Go ADK's `NewDefaultToolBox` in `server/agent_toolbox.go` so the
 * model sees identical prompting whether the agent is implemented in Go or TS.
 */
export const INPUT_REQUIRED_TOOL_DESCRIPTION =
  'REQUIRED: Use this tool when you need additional information from the user to provide a complete and accurate response. Call this instead of making assumptions or providing incomplete answers. Examples: missing location for weather, unclear requirements, ambiguous requests, or when more context would significantly improve the response quality.';

/**
 * JSON Schema advertised to the LLM for the reserved {@link INPUT_REQUIRED_TOOL}.
 * The single `message` argument carries the prompt surfaced to the user when
 * the task transitions to `INPUT_REQUIRED`.
 */
export const INPUT_REQUIRED_TOOL_PARAMETERS: Struct = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description:
        "Clear, specific message explaining exactly what additional information you need from the user to complete their request. Be specific about what's missing and why it's needed.",
    },
  },
  required: ['message'],
};

/**
 * Description advertised to the LLM for the reserved {@link CREATE_ARTIFACT_TOOL}.
 * Mirrors the Go ADK's `create_artifact` reserved tool.
 */
export const CREATE_ARTIFACT_TOOL_DESCRIPTION =
  'Create a named artifact attached to the current task. Use this to surface a discrete output (a document, a code snippet, a report) that the caller can fetch separately from the conversation transcript. Prefer this over inlining large outputs into the assistant message.';

/**
 * JSON Schema advertised to the LLM for the reserved {@link CREATE_ARTIFACT_TOOL}.
 * The handler/artifact service consuming the call is responsible for turning
 * `parts` into A2A `Part`s; this schema is intentionally permissive so it
 * does not constrain the downstream implementation.
 */
export const CREATE_ARTIFACT_TOOL_PARAMETERS: Struct = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        'Short human-readable name of the artifact (e.g. "summary.md", "design-diagram").',
    },
    description: {
      type: 'string',
      description:
        'Optional one-sentence description of the artifact contents.',
    },
    parts: {
      type: 'array',
      description:
        'Ordered array of A2A Parts forming the artifact body. Each item should be either a text part (`{type:"text", text:"..."}`) or a file part.',
      items: { type: 'object' },
    },
  },
  required: ['name', 'parts'],
};

/**
 * OpenAI-compatible tool definition advertised to the LLM. `parameters` is the
 * JSON Schema describing the tool's arguments.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Struct;
}

/**
 * Context handed to a {@link Tool.execute} call. Carries identifiers the tool
 * needs to correlate work with the surrounding task, a per-handle mutable
 * `state` bag the tool can use to stash data across iterations, a logger, and
 * an `AbortSignal` propagated from the task handler so long-running tools can
 * react to cancellation.
 *
 * The optional `task` reference is retained for power users that need access
 * to the full {@link ManagedTask} (messages, metadata, etc.).
 */
export interface ToolContext {
  /** Identifier of the surrounding A2A task. */
  readonly taskId: string;
  /** Identifier of the conversation/context the task belongs to. */
  readonly contextId: string;
  /** Name of the agent running the task. Empty when not configured. */
  readonly agentName: string;
  /**
   * Identifier of the specific LLM tool call being executed. Sourced from the
   * `id` field of the assistant tool-call message (OpenAI convention).
   */
  readonly invocationId: string;
  /**
   * Per-handle mutable state bag. The same object reference is shared across
   * every tool invocation in a single task handler run, so tools can stash
   * intermediate data for later iterations. Not persisted across handle()
   * calls or restarts.
   */
  readonly state: Record<string, unknown>;
  /** Structured logger scoped to the surrounding task handler. */
  readonly logger: Logger;
  /**
   * Cancellation signal propagated from the task handler. Tools doing I/O or
   * long-running work should pass this through to the underlying calls so
   * upstream cancellation aborts cleanly.
   */
  readonly signal: AbortSignal;
  /** Snapshot of the managed task for power users that need full context. */
  readonly task: ManagedTask;
}

/**
 * A user-registered tool. The executor runs with the raw JSON argument string
 * supplied by the model plus a {@link ToolContext} carrying the current task,
 * a mutable state bag, a logger, and a cancellation signal; it must resolve
 * with a string that is fed back to the LLM as a `tool` message.
 *
 * Mirrors the Go ADK's `Tool` interface (`server/agent_toolbox.go`).
 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Struct;
  execute(args: string, context: ToolContext): Promise<string>;
}

/**
 * Tool registry consulted by the task handlers. {@link getTools} is queried on
 * every LLM iteration to advertise available tools; {@link executeTool} runs
 * a specific tool with the raw JSON argument string the model returned and
 * yields a string the handler appends to the conversation as a `tool`
 * message.
 *
 * The mutation methods ({@link addTool}, {@link hasTool}, {@link getTool},
 * {@link getToolNames}) make the interface usable as both a producer (the
 * caller wiring up tools) and a consumer (the handler dispatching tool
 * calls). Custom toolbox implementations that prefer to be read-only can
 * have {@link addTool} throw - the handlers never call it.
 */
export interface ToolBox {
  /**
   * Snapshot of every registered tool as the OpenAI-compatible definition
   * sent to the LLM. The order is implementation-defined but stable for a
   * given toolbox state.
   */
  getTools(): readonly ToolDefinition[];
  /**
   * Dispatch the named tool. Throws {@link ToolNotFoundError} when the tool
   * is not registered and {@link ToolSchemaValidationError} when `args` does
   * not satisfy the tool's JSON Schema.
   */
  executeTool(
    name: string,
    args: string,
    context: ToolContext
  ): Promise<string>;
  /** Names of every registered tool. */
  getToolNames(): readonly string[];
  /** Whether a tool with this name is registered. */
  hasTool(name: string): boolean;
  /** Registered tool object for this name, or `undefined`. */
  getTool(name: string): Tool | undefined;
  /**
   * Register a tool. Implementations may reject names reserved by the
   * framework ({@link RESERVED_TOOL_NAMES}) - {@link DefaultToolBox} throws
   * {@link ReservedToolNameError} in that case.
   */
  addTool(tool: Tool): void;
}

/**
 * Thrown by {@link DefaultToolBox.addTool} when a user attempts to register a
 * tool whose name is reserved by the framework
 * ({@link RESERVED_TOOL_NAMES}). Exposes the offending name so callers can
 * build a descriptive error response.
 */
export class ReservedToolNameError extends Error {
  override readonly name = 'ReservedToolNameError';
  readonly toolName: string;

  constructor(toolName: string) {
    super(
      `Tool name "${toolName}" is reserved by the ADK and cannot be overridden`
    );
    this.toolName = toolName;
  }
}

/**
 * Thrown by {@link DefaultToolBox.executeTool} when the LLM asks to invoke a
 * tool the toolbox does not have.
 */
export class ToolNotFoundError extends Error {
  override readonly name = 'ToolNotFoundError';
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Tool "${toolName}" is not registered with this toolbox`);
    this.toolName = toolName;
  }
}

/**
 * Thrown by {@link DefaultToolBox.executeTool} when the JSON arguments the
 * model produced for a tool call do not satisfy the tool's declared JSON
 * Schema. The {@link errors} field carries the raw ajv error objects so
 * callers can render a descriptive diagnostic; the default
 * {@link Error.message} is a compact summary suitable for surfacing back to
 * the model.
 */
export class ToolSchemaValidationError extends Error {
  override readonly name = 'ToolSchemaValidationError';
  readonly toolName: string;
  readonly errors: readonly ErrorObject[];

  constructor(toolName: string, errors: readonly ErrorObject[]) {
    super(
      `Tool "${toolName}" arguments did not match schema: ${summarizeErrors(errors)}`
    );
    this.toolName = toolName;
    this.errors = errors;
  }
}

function summarizeErrors(errors: readonly ErrorObject[]): string {
  if (errors.length === 0) {
    return 'unknown validation failure';
  }
  return errors
    .map((err) => {
      const path = err.instancePath.length > 0 ? err.instancePath : '/';
      return `${path} ${err.message ?? 'invalid'}`;
    })
    .join('; ');
}

/**
 * Resolved value of `args` for a JSON-schema validation pass. An empty string
 * (which the OpenAI protocol uses for tools with no required arguments) is
 * coerced to an empty object so a schema like `{ type: 'object' }` still
 * validates.
 */
function parseToolArguments(args: string): unknown {
  if (args.length === 0) {
    return {};
  }
  return JSON.parse(args);
}

/**
 * Construction options for {@link DefaultToolBox}.
 */
export interface DefaultToolBoxOptions {
  /**
   * Pre-register the reserved {@link CREATE_ARTIFACT_TOOL} so the LLM is told
   * it can create named artifacts. Off by default because downstream pipelines
   * that do not handle the call have no way to act on it; opt in only when
   * the surrounding task handler / artifact service knows how to materialize
   * an artifact from the tool call.
   *
   * Like {@link INPUT_REQUIRED_TOOL}, the call is intercepted by the handler
   * before reaching the toolbox executor.
   */
  readonly enableCreateArtifact?: boolean;
  /**
   * Optional ajv instance to reuse across the toolbox. The default ajv is
   * constructed in strict mode with `allErrors: true`. Inject a custom
   * instance only when you need to register format keywords or extra
   * vocabularies.
   */
  readonly ajv?: Ajv;
}

/**
 * Default {@link ToolBox} implementation, mirroring the Go ADK's
 * `DefaultToolBox` in `server/agent_toolbox.go`.
 *
 * Auto-registers the reserved {@link INPUT_REQUIRED_TOOL} so the LLM is always
 * told it can pause and ask for user input - the
 * {@link import('./default-background-task-handler.js').DefaultBackgroundTaskHandler}
 * and {@link import('./default-streaming-task-handler.js').DefaultStreamingTaskHandler}
 * intercept calls to that tool before reaching `executeTool()` and transition
 * the task to `INPUT_REQUIRED` themselves.
 *
 * Conditionally pre-registers {@link CREATE_ARTIFACT_TOOL} when
 * {@link DefaultToolBoxOptions.enableCreateArtifact} is set.
 *
 * The toolbox refuses to register any user-defined tool whose name collides
 * with a reserved name ({@link RESERVED_TOOL_NAMES}); attempting to do so
 * throws {@link ReservedToolNameError}. This guarantees a custom
 * `input_required` cannot accidentally take over the pause/resume protocol.
 *
 * Calling {@link executeTool} validates the supplied JSON arguments against
 * the tool's declared schema using ajv (strict mode). Validation failures
 * throw {@link ToolSchemaValidationError} so the handler can surface a
 * structured error back to the model. Calling for the reserved
 * {@link INPUT_REQUIRED_TOOL} or {@link CREATE_ARTIFACT_TOOL} is a programmer
 * error - the handlers short-circuit before dispatch. The fallback executors
 * here return an empty string and do NOT change task state, matching the Go
 * ADK's no-op handlers.
 */
export class DefaultToolBox implements ToolBox {
  private readonly tools = new Map<string, Tool>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv: Ajv;

  constructor(options: DefaultToolBoxOptions = {}) {
    this.ajv =
      options.ajv ??
      new Ajv({
        strict: true,
        allErrors: true,
        // The reserved tool schemas include user-facing `description` fields
        // alongside JSON Schema keywords; ajv's strict mode would otherwise
        // reject them as unknown keywords. We trust schemas supplied by tool
        // authors are well-formed.
        strictSchema: false,
      });

    this.registerReserved({
      name: INPUT_REQUIRED_TOOL,
      description: INPUT_REQUIRED_TOOL_DESCRIPTION,
      parameters: INPUT_REQUIRED_TOOL_PARAMETERS,
    });
    if (options.enableCreateArtifact === true) {
      this.registerReserved({
        name: CREATE_ARTIFACT_TOOL,
        description: CREATE_ARTIFACT_TOOL_DESCRIPTION,
        parameters: CREATE_ARTIFACT_TOOL_PARAMETERS,
      });
    }
  }

  private registerReserved(definition: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Struct;
  }): void {
    const tool: Tool = {
      ...definition,
      execute: async () => '',
    };
    this.tools.set(tool.name, tool);
    this.validators.set(tool.name, this.ajv.compile(tool.parameters));
  }

  /**
   * Register a user tool. Throws {@link ReservedToolNameError} when `tool.name`
   * collides with a name owned by the framework. Subsequent calls with the
   * same non-reserved name overwrite the previous registration, matching the
   * Go ADK's `AddTool` semantics.
   */
  addTool(tool: Tool): void {
    if (RESERVED_TOOL_NAMES.has(tool.name)) {
      throw new ReservedToolNameError(tool.name);
    }
    this.tools.set(tool.name, tool);
    this.validators.set(tool.name, this.ajv.compile(tool.parameters));
  }

  /** Drop a registered tool by name. Returns `true` when one was removed. */
  removeTool(name: string): boolean {
    if (RESERVED_TOOL_NAMES.has(name)) {
      throw new ReservedToolNameError(name);
    }
    this.validators.delete(name);
    return this.tools.delete(name);
  }

  /** Snapshot of registered tool names. Useful for diagnostics and tests. */
  getToolNames(): readonly string[] {
    return [...this.tools.keys()];
  }

  /** Whether a tool with the given name is registered. */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Look up a registered tool by name; returns `undefined` when no tool with
   * that name has been registered.
   */
  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** {@link ToolBox.getTools} */
  getTools(): readonly ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      definitions.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
    }
    return definitions;
  }

  /** {@link ToolBox.executeTool} */
  async executeTool(
    name: string,
    args: string,
    context: ToolContext
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new ToolNotFoundError(name);
    }

    const validate = this.validators.get(name);
    if (validate !== undefined) {
      let parsed: unknown;
      try {
        parsed = parseToolArguments(args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ToolSchemaValidationError(name, [
          {
            instancePath: '',
            schemaPath: '#',
            keyword: 'parse',
            params: {},
            message: `arguments are not valid JSON: ${message}`,
          },
        ]);
      }
      if (!validate(parsed)) {
        throw new ToolSchemaValidationError(name, validate.errors ?? []);
      }
    }

    return tool.execute(args, context);
  }
}

/**
 * Convenience helper that constructs a {@link Tool} from a plain executor
 * callback. Mirrors the Go ADK's `NewBasicTool` factory in
 * `server/agent_toolbox.go`.
 *
 * ```ts
 * toolbox.addTool(createTool({
 *   name: 'now',
 *   description: 'Return the current ISO timestamp.',
 *   parameters: { type: 'object', properties: {} },
 *   execute: async () => new Date().toISOString(),
 * }));
 * ```
 */
export function createTool(definition: {
  readonly name: string;
  readonly description: string;
  readonly parameters: Struct;
  readonly execute: (args: string, context: ToolContext) => Promise<string>;
}): Tool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    execute: definition.execute,
  };
}

/**
 * Build a {@link ToolContext} from the loose fields a task handler typically
 * has at the dispatch site. Defaults `logger` to {@link NOOP_LOGGER},
 * `agentName` to the empty string, and `state` to a fresh empty record so
 * callers can supply only the fields they care about. The same `state`
 * reference should be re-used across every tool call within a single handler
 * invocation - {@link createToolContext} does NOT manage that lifetime.
 */
export function createToolContext(input: {
  readonly task: ManagedTask;
  readonly invocationId: string;
  readonly signal: AbortSignal;
  readonly state?: Record<string, unknown>;
  readonly agentName?: string;
  readonly logger?: Logger;
}): ToolContext {
  return {
    taskId: input.task.id,
    contextId: input.task.contextId,
    agentName: input.agentName ?? '',
    invocationId: input.invocationId,
    state: input.state ?? {},
    logger: input.logger ?? NOOP_LOGGER,
    signal: input.signal,
    task: input.task,
  };
}

/**
 * Re-export for symmetry with the rest of the public surface; callers that
 * only depend on `toolbox.ts` shouldn't have to reach into other modules for
 * the shared `ManagedTask` type.
 */
export type { ManagedTask };
