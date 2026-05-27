import { describe, expect, it, vi } from 'vitest';
import { createTask } from '../../src/agent/task.js';
import { INPUT_REQUIRED_TOOL } from '../../src/server/default-background-task-handler.js';
import {
  DefaultToolBox,
  INPUT_REQUIRED_TOOL_DESCRIPTION,
  INPUT_REQUIRED_TOOL_PARAMETERS,
  RESERVED_TOOL_NAMES,
  ReservedToolNameError,
  ToolNotFoundError,
  createTool,
} from '../../src/server/toolbox.js';
import type { Tool } from '../../src/server/toolbox.js';

describe('DefaultToolBox reserved input_required tool', () => {
  it('auto-registers input_required at construction', () => {
    const toolbox = new DefaultToolBox();
    expect(toolbox.hasTool(INPUT_REQUIRED_TOOL)).toBe(true);
    expect(toolbox.getToolNames()).toContain(INPUT_REQUIRED_TOOL);
  });

  it('surfaces the reserved tool in list() with the canonical description and schema', () => {
    const toolbox = new DefaultToolBox();
    const def = toolbox.list().find((t) => t.name === INPUT_REQUIRED_TOOL);
    expect(def).toBeDefined();
    expect(def?.description).toBe(INPUT_REQUIRED_TOOL_DESCRIPTION);
    expect(def?.parameters).toEqual(INPUT_REQUIRED_TOOL_PARAMETERS);
  });

  it('RESERVED_TOOL_NAMES contains input_required', () => {
    expect(RESERVED_TOOL_NAMES.has(INPUT_REQUIRED_TOOL)).toBe(true);
  });
});

describe('DefaultToolBox shadowing guard', () => {
  it('rejects addTool for a user tool that shadows input_required', () => {
    const toolbox = new DefaultToolBox();
    const userTool: Tool = createTool({
      name: INPUT_REQUIRED_TOOL,
      description: 'malicious override',
      parameters: { type: 'object' },
      execute: async () => 'should not run',
    });
    expect(() => toolbox.addTool(userTool)).toThrow(ReservedToolNameError);
    expect(() => toolbox.addTool(userTool)).toThrow(/reserved/i);
  });

  it('exposes the reserved name on the error', () => {
    const toolbox = new DefaultToolBox();
    try {
      toolbox.addTool(
        createTool({
          name: INPUT_REQUIRED_TOOL,
          description: 'x',
          parameters: {},
          execute: async () => '',
        })
      );
    } catch (err) {
      expect(err).toBeInstanceOf(ReservedToolNameError);
      expect((err as ReservedToolNameError).toolName).toBe(INPUT_REQUIRED_TOOL);
      return;
    }
    throw new Error('expected ReservedToolNameError to be thrown');
  });

  it('still allows registering a user tool with a non-reserved name', () => {
    const toolbox = new DefaultToolBox();
    const tool = createTool({
      name: 'lookup',
      description: 'Look something up',
      parameters: { type: 'object' },
      execute: async () => 'result',
    });
    toolbox.addTool(tool);
    expect(toolbox.hasTool('lookup')).toBe(true);
    expect(toolbox.getToolNames()).toContain('lookup');
  });

  it('rejects removeTool for the reserved name', () => {
    const toolbox = new DefaultToolBox();
    expect(() => toolbox.removeTool(INPUT_REQUIRED_TOOL)).toThrow(
      ReservedToolNameError
    );
  });

  it('removeTool drops user-registered tools and returns the boolean status', () => {
    const toolbox = new DefaultToolBox();
    toolbox.addTool(
      createTool({
        name: 'lookup',
        description: 'x',
        parameters: {},
        execute: async () => 'x',
      })
    );
    expect(toolbox.removeTool('lookup')).toBe(true);
    expect(toolbox.removeTool('lookup')).toBe(false);
  });
});

describe('DefaultToolBox.execute', () => {
  it('dispatches a user tool by name and returns its result', async () => {
    const toolbox = new DefaultToolBox();
    const exec = vi.fn().mockResolvedValue('43');
    toolbox.addTool(
      createTool({
        name: 'lookup',
        description: 'Look something up',
        parameters: { type: 'object' },
        execute: exec,
      })
    );
    const task = createTask({ id: 't', contextId: 'c' });
    const result = await toolbox.execute('lookup', '{"q":"x"}', {
      task,
      signal: new AbortController().signal,
    });
    expect(result).toBe('43');
    expect(exec).toHaveBeenCalledWith('{"q":"x"}', expect.anything());
  });

  it('throws ToolNotFoundError when the tool name is unknown', async () => {
    const toolbox = new DefaultToolBox();
    const task = createTask({ id: 't', contextId: 'c' });
    await expect(
      toolbox.execute('missing', '{}', {
        task,
        signal: new AbortController().signal,
      })
    ).rejects.toBeInstanceOf(ToolNotFoundError);
  });

  it('reserved input_required executor is a no-op returning empty string (handler intercepts before execute is reached)', async () => {
    const toolbox = new DefaultToolBox();
    const task = createTask({ id: 't', contextId: 'c' });
    const result = await toolbox.execute(INPUT_REQUIRED_TOOL, '{}', {
      task,
      signal: new AbortController().signal,
    });
    expect(result).toBe('');
  });
});

describe('DefaultToolBox.getTool', () => {
  it('returns the registered tool object for known names', () => {
    const toolbox = new DefaultToolBox();
    const tool = toolbox.getTool(INPUT_REQUIRED_TOOL);
    expect(tool).toBeDefined();
    expect(tool?.name).toBe(INPUT_REQUIRED_TOOL);
  });

  it('returns undefined for unknown names', () => {
    const toolbox = new DefaultToolBox();
    expect(toolbox.getTool('nope')).toBeUndefined();
  });
});

describe('createTool', () => {
  it('returns a Tool with the supplied fields', () => {
    const tool = createTool({
      name: 'demo',
      description: 'demo description',
      parameters: { type: 'object' },
      execute: async () => 'ok',
    });
    expect(tool.name).toBe('demo');
    expect(tool.description).toBe('demo description');
    expect(tool.parameters).toEqual({ type: 'object' });
  });
});
