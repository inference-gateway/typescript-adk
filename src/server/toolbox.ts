import type { ManagedTask } from '../agent/task.js';
import type { Struct } from '../types/generated/a2a.js';
import {
  INPUT_REQUIRED_TOOL,
  type ToolBox,
  type ToolDefinition,
  type ToolExecutionContext,
} from './default-background-task-handler.js';

/**
 * Reserved tool names that {@link DefaultToolBox} owns and refuses to let user
 * tools shadow. Currently a singleton ({@link INPUT_REQUIRED_TOOL}); kept as a
 * set so future reserved names can be added in one place.
 */
export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  INPUT_REQUIRED_TOOL,
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
 * Thrown by {@link DefaultToolBox.execute} when the LLM asks to invoke a tool
 * the toolbox does not have.
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
 * A user-registered tool. The executor runs with the raw JSON argument string
 * supplied by the model plus a {@link ToolExecutionContext} carrying the
 * current task and a cancellation signal; it must resolve with a string that
 * is fed back to the LLM as a `tool` message.
 *
 * Mirrors the Go ADK's `Tool` interface (`server/agent_toolbox.go`).
 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Struct;
  execute(args: string, context: ToolExecutionContext): Promise<string>;
}

/**
 * Default {@link ToolBox} implementation, mirroring the Go ADK's
 * `DefaultToolBox` in `server/agent_toolbox.go`.
 *
 * Auto-registers the reserved {@link INPUT_REQUIRED_TOOL} so the LLM is always
 * told it can pause and ask for user input - the
 * {@link import('./default-background-task-handler.js').DefaultBackgroundTaskHandler}
 * and {@link import('./default-streaming-task-handler.js').DefaultStreamingTaskHandler}
 * intercept calls to that tool before reaching `execute()` and transition the
 * task to `INPUT_REQUIRED` themselves.
 *
 * The toolbox refuses to register any user-defined tool whose name collides
 * with a reserved name ({@link RESERVED_TOOL_NAMES}); attempting to do so
 * throws {@link ReservedToolNameError}. This guarantees a custom `input_required`
 * cannot accidentally take over the pause/resume protocol.
 *
 * Calling {@link execute} for the reserved {@link INPUT_REQUIRED_TOOL} is a
 * programmer error - the handlers are expected to short-circuit before
 * dispatching. The fallback implementation here returns an empty string and
 * does NOT transition the task, matching the Go ADK's no-op handler.
 */
export class DefaultToolBox implements ToolBox {
  private readonly tools = new Map<string, Tool>();

  constructor() {
    this.tools.set(INPUT_REQUIRED_TOOL, {
      name: INPUT_REQUIRED_TOOL,
      description: INPUT_REQUIRED_TOOL_DESCRIPTION,
      parameters: INPUT_REQUIRED_TOOL_PARAMETERS,
      // The default handlers intercept this tool call before dispatch; the
      // executor below only runs if a custom handler bypasses the interception.
      execute: async () => '',
    });
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
  }

  /** Drop a registered tool by name. Returns `true` when one was removed. */
  removeTool(name: string): boolean {
    if (RESERVED_TOOL_NAMES.has(name)) {
      throw new ReservedToolNameError(name);
    }
    return this.tools.delete(name);
  }

  /** Snapshot of registered tool names. Useful for diagnostics and tests. */
  getToolNames(): string[] {
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

  /** {@link ToolBox.list} */
  list(): readonly ToolDefinition[] {
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

  /** {@link ToolBox.execute} */
  async execute(
    name: string,
    args: string,
    context: ToolExecutionContext
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new ToolNotFoundError(name);
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
  readonly execute: (
    args: string,
    context: ToolExecutionContext
  ) => Promise<string>;
}): Tool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    execute: definition.execute,
  };
}

/**
 * Re-export for symmetry with the rest of the public surface; callers that
 * only depend on `toolbox.ts` shouldn't have to reach into
 * `default-background-task-handler.ts` for the shared tool-execution context.
 */
export type { ManagedTask, ToolExecutionContext };
