import type { Struct } from '../types/generated/a2a.js';
import type { Tool, ToolBox, ToolContext } from '../server/toolbox.js';
import type { MCPToolProvider } from './client.js';

/**
 * Name of the selector tool that lists tools discovered from MCP servers.
 * Mirrors the Go ADK's `mcp_list_tools`.
 */
export const MCP_LIST_TOOLS_TOOL = 'mcp_list_tools' as const;

/**
 * Name of the selector tool that invokes a discovered MCP tool by name.
 * Mirrors the Go ADK's `mcp_call_tool`.
 */
export const MCP_CALL_TOOL_TOOL = 'mcp_call_tool' as const;

export const MCP_LIST_TOOLS_DESCRIPTION =
  'List tools discovered from the configured MCP (Model Context Protocol) servers. Returns each tool with its server, name, description, and input schema. Call this first to find a tool, then invoke it with mcp_call_tool. Pass an optional "search" filter to narrow the list by name or description.';

export const MCP_CALL_TOOL_DESCRIPTION =
  'Invoke a tool exposed by an MCP (Model Context Protocol) server. Identify the tool with the "name" returned by mcp_list_tools (optionally disambiguated by "server"), and pass its inputs as the "arguments" object matching that tool\'s input schema.';

export const MCP_LIST_TOOLS_PARAMETERS: Struct = {
  type: 'object',
  properties: {
    search: {
      type: 'string',
      description:
        'Optional case-insensitive substring filter applied to the tool name and description.',
    },
  },
};

export const MCP_CALL_TOOL_PARAMETERS: Struct = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        'Name of the MCP tool to invoke (as returned by mcp_list_tools).',
    },
    server: {
      type: 'string',
      description:
        'Optional MCP server base URL, to disambiguate a tool name exposed by more than one server.',
    },
    arguments: {
      type: 'object',
      description:
        "Arguments passed to the tool, matching the tool's input schema. Omit or pass {} for tools that take no arguments.",
      additionalProperties: true,
    },
  },
  required: ['name'],
};

function parseArgs(raw: string): Record<string, unknown> {
  if (raw.length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  return parsed !== null && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Build the `mcp_list_tools` selector tool backed by `provider`. Returns an
 * in-memory snapshot; never touches the network.
 */
export function createMCPListToolsTool(provider: MCPToolProvider): Tool {
  return {
    name: MCP_LIST_TOOLS_TOOL,
    description: MCP_LIST_TOOLS_DESCRIPTION,
    parameters: MCP_LIST_TOOLS_PARAMETERS,
    execute: async (rawArgs: string): Promise<string> => {
      const args = parseArgs(rawArgs);
      const search =
        typeof args['search'] === 'string' ? args['search'] : undefined;
      const tools = provider.listTools(search).map((t) => ({
        server: t.server,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return JSON.stringify({ tools });
    },
  };
}

/**
 * Build the `mcp_call_tool` selector tool backed by `provider`. Forwards the
 * task's cancellation signal to the underlying MCP call.
 */
export function createMCPCallToolTool(provider: MCPToolProvider): Tool {
  return {
    name: MCP_CALL_TOOL_TOOL,
    description: MCP_CALL_TOOL_DESCRIPTION,
    parameters: MCP_CALL_TOOL_PARAMETERS,
    execute: async (rawArgs: string, context: ToolContext): Promise<string> => {
      const args = parseArgs(rawArgs);
      const name = args['name'];
      if (typeof name !== 'string' || name.length === 0) {
        return JSON.stringify({
          isError: true,
          error: 'mcp_call_tool requires a non-empty "name"',
        });
      }
      const server =
        typeof args['server'] === 'string' ? args['server'] : undefined;
      const toolArgs =
        args['arguments'] !== null && typeof args['arguments'] === 'object'
          ? (args['arguments'] as Record<string, unknown>)
          : {};
      return provider.callTool(
        {
          name,
          ...(server !== undefined ? { server } : {}),
          arguments: toolArgs,
        },
        context.signal
      );
    },
  };
}

/**
 * Register both MCP selector tools (`mcp_list_tools`, `mcp_call_tool`) onto
 * `toolBox`, backed by `provider`. This is the context-friendly wiring: the LLM
 * sees exactly two tools regardless of how many the MCP servers expose.
 */
export function registerMCPTools(
  toolBox: ToolBox,
  provider: MCPToolProvider
): void {
  toolBox.addTool(createMCPListToolsTool(provider));
  toolBox.addTool(createMCPCallToolTool(provider));
}
