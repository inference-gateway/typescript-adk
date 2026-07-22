import { describe, expect, it } from 'vitest';
import { DefaultToolBox, createToolContext } from '../../src/server/toolbox.js';
import { createTask } from '../../src/agent/task.js';
import {
  MCP_CALL_TOOL_TOOL,
  MCP_LIST_TOOLS_TOOL,
  createMCPCallToolTool,
  createMCPListToolsTool,
  registerMCPTools,
  type DiscoveredMCPTool,
  type MCPCallToolInput,
  type MCPToolProvider,
} from '../../src/mcp/index.js';
import type { ToolContext } from '../../src/server/toolbox.js';

const SAMPLE_TOOLS: DiscoveredMCPTool[] = [
  {
    server: 'http://a:8080',
    name: 'get_weather',
    description: 'Weather by city',
    inputSchema: { type: 'object' },
  },
  {
    server: 'http://b:9090',
    name: 'send_email',
    description: 'Send an email message',
    inputSchema: { type: 'object' },
  },
];

class FakeProvider implements MCPToolProvider {
  lastSearch: string | undefined;
  lastCall: MCPCallToolInput | undefined;
  lastSignal: AbortSignal | undefined;

  listTools(search?: string): readonly DiscoveredMCPTool[] {
    this.lastSearch = search;
    if (search === undefined) {
      return SAMPLE_TOOLS;
    }
    return SAMPLE_TOOLS.filter((t) => t.name.includes(search));
  }

  async callTool(
    input: MCPCallToolInput,
    signal?: AbortSignal
  ): Promise<string> {
    this.lastCall = input;
    this.lastSignal = signal;
    return JSON.stringify({ ok: true, name: input.name });
  }
}

function context(): ToolContext {
  const task = createTask({ id: 't1', contextId: 'c1' });
  return createToolContext({
    task,
    invocationId: 'inv1',
    signal: new AbortController().signal,
  });
}

describe('mcp selector tools', () => {
  it('mcp_list_tools returns the snapshot as JSON and forwards the search filter', async () => {
    const provider = new FakeProvider();
    const tool = createMCPListToolsTool(provider);

    const all = JSON.parse(await tool.execute('', context())) as {
      tools: DiscoveredMCPTool[];
    };
    expect(all.tools).toHaveLength(2);
    expect(provider.lastSearch).toBeUndefined();

    const filtered = JSON.parse(
      await tool.execute(JSON.stringify({ search: 'weather' }), context())
    ) as { tools: DiscoveredMCPTool[] };
    expect(provider.lastSearch).toBe('weather');
    expect(filtered.tools.map((t) => t.name)).toEqual(['get_weather']);
  });

  it('mcp_call_tool forwards name, server, arguments, and the abort signal', async () => {
    const provider = new FakeProvider();
    const tool = createMCPCallToolTool(provider);
    const ctx = context();

    const result = await tool.execute(
      JSON.stringify({
        name: 'send_email',
        server: 'http://b:9090',
        arguments: { to: 'a@b.c' },
      }),
      ctx
    );

    expect(JSON.parse(result)).toEqual({ ok: true, name: 'send_email' });
    expect(provider.lastCall).toEqual({
      name: 'send_email',
      server: 'http://b:9090',
      arguments: { to: 'a@b.c' },
    });
    expect(provider.lastSignal).toBe(ctx.signal);
  });

  it('mcp_call_tool returns an error payload when name is missing', async () => {
    const provider = new FakeProvider();
    const tool = createMCPCallToolTool(provider);
    const result = JSON.parse(
      await tool.execute(JSON.stringify({ arguments: {} }), context())
    ) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(provider.lastCall).toBeUndefined();
  });

  it('registerMCPTools adds exactly the two selector tools to a toolbox', () => {
    const toolBox = new DefaultToolBox();
    registerMCPTools(toolBox, new FakeProvider());
    expect(toolBox.hasTool(MCP_LIST_TOOLS_TOOL)).toBe(true);
    expect(toolBox.hasTool(MCP_CALL_TOOL_TOOL)).toBe(true);
  });
});
